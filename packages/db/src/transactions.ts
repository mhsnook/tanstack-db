import { createDeferred } from './deferred'
import { safeRandomUUID } from './utils/uuid'
import './duplicate-instance-check'
import {
  MissingMutationFunctionError,
  TransactionAlreadyCompletedRollbackError,
  TransactionNotPendingCommitError,
  TransactionNotPendingMutateError,
} from './errors'
import { transactionScopedScheduler } from './scheduler.js'
import type { Deferred } from './deferred'
import type {
  MutationFn,
  PendingMutation,
  TransactionConfig,
  TransactionState,
  TransactionWithMutations,
} from './types'

const transactions: Array<Transaction<any>> = []
let transactionStack: Array<Transaction<any>> = []

let sequenceNumber = 0

/**
 * Merges two pending mutations for the same item within a transaction
 *
 * Merge behavior truth table:
 * - (insert, update) → insert (merge changes, keep empty original)
 * - (insert, delete) → null (cancel both mutations)
 * - (update, delete) → delete (delete dominates)
 * - (update, update) → update (replace with latest, union changes)
 * - (delete, delete) → delete (replace with latest)
 * - (insert, insert) → insert (replace with latest)
 *
 * Note: (delete, update) and (delete, insert) should never occur as the collection
 * layer prevents operations on deleted items within the same transaction.
 *
 * @param existing - The existing mutation in the transaction
 * @param incoming - The new mutation being applied
 * @returns The merged mutation, or null if both should be removed
 */
function mergePendingMutations<T extends object>(
  existing: PendingMutation<T>,
  incoming: PendingMutation<T>,
): PendingMutation<T> | null {
  // Truth table implementation
  switch (`${existing.type}-${incoming.type}` as const) {
    case `insert-update`: {
      // Update after insert: keep as insert but merge changes
      // For insert-update, the key should remain the same since collections don't allow key changes
      return {
        ...existing,
        type: `insert` as const,
        original: {},
        modified: incoming.modified,
        changes: { ...existing.changes, ...incoming.changes },
        // Keep existing keys (key changes not allowed in updates)
        key: existing.key,
        globalKey: existing.globalKey,
        // Merge metadata (last-write-wins)
        metadata: incoming.metadata ?? existing.metadata,
        syncMetadata: { ...existing.syncMetadata, ...incoming.syncMetadata },
        // Update tracking info
        mutationId: incoming.mutationId,
        updatedAt: incoming.updatedAt,
      }
    }

    case `insert-delete`:
      // Delete after insert: cancel both mutations
      return null

    case `update-delete`:
      // Delete after update: delete dominates
      return incoming

    case `update-update`: {
      // Update after update: replace with latest, union changes
      return {
        ...incoming,
        // Keep original from first update
        original: existing.original,
        // Union the changes from both updates
        changes: { ...existing.changes, ...incoming.changes },
        // Merge metadata
        metadata: incoming.metadata ?? existing.metadata,
        syncMetadata: { ...existing.syncMetadata, ...incoming.syncMetadata },
      }
    }

    case `delete-delete`:
    case `insert-insert`:
      // Same type: replace with latest
      return incoming

    default: {
      // Exhaustiveness check
      const _exhaustive: never = `${existing.type}-${incoming.type}` as never
      throw new Error(`Unhandled mutation combination: ${_exhaustive}`)
    }
  }
}

/**
 * Creates a new transaction for grouping multiple collection operations
 * @param config - Transaction configuration with mutation function
 * @returns A new Transaction instance
 * @example
 * // Basic transaction usage
 * const tx = createTransaction({
 *   mutationFn: async ({ transaction }) => {
 *     // Send all mutations to API
 *     await api.saveChanges(transaction.mutations)
 *   }
 * })
 *
 * tx.mutate(() => {
 *   collection.insert({ id: "1", text: "Buy milk" })
 *   collection.update("2", draft => { draft.completed = true })
 * })
 *
 * await tx.isPersisted.promise
 *
 * @example
 * // Handle transaction errors
 * try {
 *   const tx = createTransaction({
 *     mutationFn: async () => { throw new Error("API failed") }
 *   })
 *
 *   tx.mutate(() => {
 *     collection.insert({ id: "1", text: "New item" })
 *   })
 *
 *   await tx.isPersisted.promise
 * } catch (error) {
 *   console.log('Transaction failed:', error)
 * }
 *
 * @example
 * // Manual commit control
 * const tx = createTransaction({
 *   autoCommit: false,
 *   mutationFn: async () => {
 *     // API call
 *   }
 * })
 *
 * tx.mutate(() => {
 *   collection.insert({ id: "1", text: "Item" })
 * })
 *
 * // Commit later
 * await tx.commit()
 */
export function createTransaction<T extends object = Record<string, unknown>>(
  config: TransactionConfig<T>,
): Transaction<T> {
  const newTransaction = new Transaction<T>(config)
  transactions.push(newTransaction)
  return newTransaction
}

/**
 * Gets the currently active ambient transaction, if any
 * Used internally by collection operations to join existing transactions
 * @returns The active transaction or undefined if none is active
 * @example
 * // Check if operations will join an ambient transaction
 * const ambientTx = getActiveTransaction()
 * if (ambientTx) {
 *   console.log('Operations will join transaction:', ambientTx.id)
 * }
 */
export function getActiveTransaction(): Transaction | undefined {
  if (transactionStack.length > 0) {
    return transactionStack.slice(-1)[0]
  } else {
    return undefined
  }
}

function registerTransaction(tx: Transaction<any>) {
  // Clear any stale work that may have been left behind if a previous mutate
  // scope aborted before we could flush.
  transactionScopedScheduler.clear(tx.id)
  transactionStack.push(tx)
}

function unregisterTransaction(tx: Transaction<any>) {
  // Always flush pending work for this transaction before removing it from
  // the ambient stack – this runs even if the mutate callback throws.
  // If flush throws (e.g., due to a job error), we still clean up the stack.
  try {
    transactionScopedScheduler.flush(tx.id)
  } finally {
    transactionStack = transactionStack.filter((t) => t.id !== tx.id)
  }
}

function removeFromPendingList(tx: Transaction<any>) {
  const index = transactions.findIndex((t) => t.id === tx.id)
  if (index !== -1) {
    transactions.splice(index, 1)
  }
}

class Transaction<T extends object = Record<string, unknown>> {
  public id: string
  public state: TransactionState
  public mutationFn: MutationFn<T>
  public mutations: Array<PendingMutation<T>>
  /**
   * @deprecated Prefer {@link Transaction.isSettled}. `isPersisted` is the **same
   * `Deferred` object** as `isSettled` (`tx.isPersisted === tx.isSettled`), kept for
   * backwards compatibility — so the settled milestone reads in parallel with the
   * acknowledged one (`isAcknowledged`/`isSettled`) and the two can never diverge.
   */
  public isPersisted: Deferred<Transaction<T>>
  /**
   * Resolves when the write has fully *settled* — synced back so the optimistic
   * overlay is dropped. Rejects if the transaction fails. Exact synonym of the
   * (deprecated) `isPersisted`.
   */
  public isSettled: Deferred<Transaction<T>>
  public isAcknowledged: Deferred<Transaction<T>>
  public acknowledged: boolean
  /**
   * A framework-owned settle step registered via {@link Transaction.settleWith}.
   * When set, `commit()` awaits it (keeping the transaction in `persisting`, so
   * the optimistic overlay is held) after the handler returns, before settling.
   * @internal
   */
  public settleFn?: () => Promise<unknown>
  public autoCommit: boolean
  public createdAt: Date
  public sequenceNumber: number
  public metadata: Record<string, unknown>
  public error?: {
    message: string
    error: Error
  }

  constructor(config: TransactionConfig<T>) {
    if (typeof config.mutationFn === `undefined`) {
      throw new MissingMutationFunctionError()
    }
    this.id = config.id ?? safeRandomUUID()
    this.mutationFn = config.mutationFn
    this.state = `pending`
    this.mutations = []
    this.isSettled = createDeferred<Transaction<T>>()
    // isPersisted is an exact alias of isSettled — the same Deferred, so they can
    // never diverge in value or timing. Resolve/reject isSettled and isPersisted
    // follows automatically.
    this.isPersisted = this.isSettled
    this.isAcknowledged = createDeferred<Transaction<T>>()
    this.acknowledged = false
    // Prevent unhandled-rejection noise when nobody awaits these on a failing
    // transaction; explicit awaiters still observe the rejection.
    void this.isAcknowledged.promise.catch(() => {})
    void this.isSettled.promise.catch(() => {})
    this.autoCommit = config.autoCommit ?? true
    this.createdAt = new Date()
    this.sequenceNumber = sequenceNumber++
    this.metadata = config.metadata ?? {}
  }

  setState(newState: TransactionState) {
    this.state = newState

    if (newState === `completed` || newState === `failed`) {
      removeFromPendingList(this)
    }
  }

  /**
   * Execute collection operations within this transaction
   * @param callback - Synchronous function containing collection operations to group together.
   * The transaction context is active only for the synchronous duration of this callback.
   * Async work should happen in `mutationFn`; collection operations after `await` boundaries
   * inside this callback will not be part of this transaction. For manual transactions, call
   * `mutate` multiple times before committing to add more synchronous operations to the same
   * transaction.
   * @returns This transaction for chaining
   * @example
   * // Group multiple operations
   * const tx = createTransaction({ mutationFn: async () => {
   *   // Send to API
   * }})
   *
   * tx.mutate(() => {
   *   collection.insert({ id: "1", text: "Buy milk" })
   *   collection.update("2", draft => { draft.completed = true })
   *   collection.delete("3")
   * })
   *
   * await tx.isPersisted.promise
   *
   * @example
   * // Handle mutate errors
   * try {
   *   tx.mutate(() => {
   *     collection.insert({ id: "invalid" }) // This might throw
   *   })
   * } catch (error) {
   *   console.log('Mutation failed:', error)
   * }
   *
   * @example
   * // Manual commit control
   * const tx = createTransaction({ autoCommit: false, mutationFn: async () => {} })
   *
   * tx.mutate(() => {
   *   collection.insert({ id: "1", text: "Item" })
   * })
   *
   * // Add more synchronous mutations to the same transaction
   * tx.mutate(() => {
   *   collection.update("1", draft => { draft.text = "Updated item" })
   * })
   *
   * // Commit later when ready
   * await tx.commit()
   */
  mutate(callback: () => void): Transaction<T> {
    if (this.state !== `pending`) {
      throw new TransactionNotPendingMutateError()
    }

    registerTransaction(this)

    try {
      callback()
    } finally {
      unregisterTransaction(this)
    }

    if (this.autoCommit) {
      this.commit().catch(() => {
        // Errors from autoCommit are handled via isPersisted.promise
        // This catch prevents unhandled promise rejections
      })
    }

    return this
  }

  /**
   * Apply new mutations to this transaction, intelligently merging with existing mutations
   *
   * When mutations operate on the same item (same globalKey), they are merged according to
   * the following rules:
   *
   * - **insert + update** → insert (merge changes, keep empty original)
   * - **insert + delete** → removed (mutations cancel each other out)
   * - **update + delete** → delete (delete dominates)
   * - **update + update** → update (union changes, keep first original)
   * - **same type** → replace with latest
   *
   * This merging reduces over-the-wire churn and keeps the optimistic local view
   * aligned with user intent.
   *
   * @param mutations - Array of new mutations to apply
   */
  applyMutations(mutations: Array<PendingMutation<any>>): void {
    for (const newMutation of mutations) {
      const existingIndex = this.mutations.findIndex(
        (m) => m.globalKey === newMutation.globalKey,
      )

      if (existingIndex >= 0) {
        const existingMutation = this.mutations[existingIndex]!
        const mergeResult = mergePendingMutations(existingMutation, newMutation)

        if (mergeResult === null) {
          // Remove the mutation (e.g., delete after insert cancels both)
          this.mutations.splice(existingIndex, 1)
        } else {
          // Replace with merged mutation
          this.mutations[existingIndex] = mergeResult
        }
      } else {
        // Insert new mutation
        this.mutations.push(newMutation)
      }
    }
  }

  /**
   * Rollback the transaction and any conflicting transactions
   * @param config - Configuration for rollback behavior
   * @returns This transaction for chaining
   * @example
   * // Manual rollback
   * const tx = createTransaction({ mutationFn: async () => {
   *   // Send to API
   * }})
   *
   * tx.mutate(() => {
   *   collection.insert({ id: "1", text: "Buy milk" })
   * })
   *
   * // Rollback if needed
   * if (shouldCancel) {
   *   tx.rollback()
   * }
   *
   * @example
   * // Handle rollback cascade (automatic)
   * const tx1 = createTransaction({ mutationFn: async () => {} })
   * const tx2 = createTransaction({ mutationFn: async () => {} })
   *
   * tx1.mutate(() => collection.update("1", draft => { draft.value = "A" }))
   * tx2.mutate(() => collection.update("1", draft => { draft.value = "B" })) // Same item
   *
   * tx1.rollback() // This will also rollback tx2 due to conflict
   *
   * @example
   * // Handle rollback in error scenarios
   * try {
   *   await tx.isPersisted.promise
   * } catch (error) {
   *   console.log('Transaction was rolled back:', error)
   *   // Transaction automatically rolled back on mutation function failure
   * }
   */
  rollback(config?: { isSecondaryRollback?: boolean }): Transaction<T> {
    const isSecondaryRollback = config?.isSecondaryRollback ?? false
    if (this.state === `completed`) {
      throw new TransactionAlreadyCompletedRollbackError()
    }

    this.setState(`failed`)

    // See if there's any other transactions w/ mutations on the same ids
    // and roll them back as well.
    if (!isSecondaryRollback) {
      const mutationIds = new Set()
      this.mutations.forEach((m) => mutationIds.add(m.globalKey))
      for (const t of transactions) {
        t.state === `pending` &&
          t.mutations.some((m) => mutationIds.has(m.globalKey)) &&
          t.rollback({ isSecondaryRollback: true })
      }
    }

    // Reject the promises. A failed transaction was never acknowledged (unless
    // the ack already arrived before the failure).
    if (this.isAcknowledged.isPending()) {
      this.isAcknowledged.reject(this.error?.error)
    }
    if (this.isSettled.isPending()) {
      // isPersisted is the same Deferred, so this rejects both.
      this.isSettled.reject(this.error?.error)
    }
    this.touchCollection()

    return this
  }

  // Tell collection that something has changed with the transaction
  touchCollection(): void {
    const hasCalled = new Set()
    for (const mutation of this.mutations) {
      if (!hasCalled.has(mutation.collection.id)) {
        mutation.collection._state.onTransactionStateChange()

        // Only call commitPendingTransactions if there are pending sync transactions
        if (mutation.collection._state.pendingSyncedTransactions.length > 0) {
          mutation.collection._state.commitPendingTransactions()
        }

        hasCalled.add(mutation.collection.id)
      }
    }
  }

  /**
   * Mark this transaction as *acknowledged* by the server — the write was
   * accepted — without waiting for it to sync back ("settle").
   *
   * Collection adapters for backends with realtime sync call this as soon as the
   * server confirms the write but before the change echoes back through sync. It
   * resolves {@link Transaction.isAcknowledged} and flips the `$acknowledged`
   * virtual property on the affected rows, letting UIs respond to the ack without
   * waiting for the echo.
   *
   * This is purely additive: it does not change when the handler resolves, the
   * optimistic overlay, or `isPersisted`/`$synced`. No-op if the transaction has
   * already been acknowledged, completed, or failed.
   * @returns This transaction for chaining
   */
  acknowledge(): Transaction<T> {
    if (
      this.acknowledged ||
      this.state === `completed` ||
      this.state === `failed`
    ) {
      return this
    }

    this.acknowledged = true
    this.isAcknowledged.resolve(this)

    // Notify each affected collection so it flips $acknowledged and emits updates.
    const notified = new Set<string>()
    for (const mutation of this.mutations) {
      if (notified.has(mutation.collection.id)) {
        continue
      }
      notified.add(mutation.collection.id)
      mutation.collection._state.onTransactionAcknowledged(this)
    }

    return this
  }

  /**
   * Hand the *settle* step to the framework instead of blocking the handler.
   *
   * A collection adapter calls this with a thunk that resolves once the write
   * has synced back (e.g. awaiting a txid in the replication stream). The handler
   * can then return at the ack; `commit()` keeps the transaction in `persisting`
   * (so the optimistic overlay is held — no flicker) until the thunk resolves,
   * then settles: drops the overlay and resolves `isSettled` / `isPersisted`.
   *
   * Registering a settle step also *implies the acknowledgement*: when the handler
   * returns without throwing, `commit()` flips `isAcknowledged` / `$acknowledged`
   * before awaiting the thunk, so the adapter does not need a separate
   * {@link Transaction.acknowledge} call (calling it explicitly is still a safe
   * no-op). The settle milestone (`isSettled` / `isPersisted`) resolves when the
   * thunk does.
   *
   * If the thunk rejects, the transaction fails and rolls back, exactly as a
   * throwing handler would. The acknowledgement, once flipped, is not retracted.
   * @returns This transaction for chaining
   */
  settleWith(fn: () => Promise<unknown>): Transaction<T> {
    this.settleFn = fn
    return this
  }

  /**
   * Commit the transaction and execute the mutation function
   * @returns Promise that resolves to this transaction when complete
   * @example
   * // Manual commit (when autoCommit is false)
   * const tx = createTransaction({
   *   autoCommit: false,
   *   mutationFn: async ({ transaction }) => {
   *     await api.saveChanges(transaction.mutations)
   *   }
   * })
   *
   * tx.mutate(() => {
   *   collection.insert({ id: "1", text: "Buy milk" })
   * })
   *
   * await tx.commit() // Manually commit
   *
   * @example
   * // Handle commit errors
   * try {
   *   const tx = createTransaction({
   *     mutationFn: async () => { throw new Error("API failed") }
   *   })
   *
   *   tx.mutate(() => {
   *     collection.insert({ id: "1", text: "Item" })
   *   })
   *
   *   await tx.commit()
   * } catch (error) {
   *   console.log('Commit failed, transaction rolled back:', error)
   * }
   *
   * @example
   * // Check transaction state after commit
   * await tx.commit()
   * console.log(tx.state) // "completed" or "failed"
   */
  async commit(): Promise<Transaction<T>> {
    if (this.state !== `pending`) {
      throw new TransactionNotPendingCommitError()
    }

    this.setState(`persisting`)

    if (this.mutations.length === 0) {
      this.setState(`completed`)
      if (this.isAcknowledged.isPending()) {
        this.acknowledged = true
        this.isAcknowledged.resolve(this)
      }
      // isPersisted is the same Deferred, so this resolves both.
      this.isSettled.resolve(this)

      return this
    }

    // Run mutationFn
    try {
      // At this point we know there's at least one mutation
      // We've already verified mutations is non-empty, so this cast is safe
      // Use a direct type assertion instead of object spreading to preserve the original type
      await this.mutationFn({
        transaction: this as unknown as TransactionWithMutations<T>,
      })

      // If the adapter handed the settle step to the framework, the handler has
      // resolved without throwing — that *is* the acknowledgement. Flip
      // `acknowledged` now (idempotent if the adapter already called it), then
      // await the settle step while still `persisting` so the optimistic overlay
      // is held (no flicker) until the change has synced back.
      if (this.settleFn) {
        this.acknowledge()
        await this.settleFn()
      }

      this.setState(`completed`)
      this.touchCollection()

      // A settled write is necessarily acknowledged. If the collection adapter
      // never called acknowledge() (e.g. it has no separate ack), the two
      // milestones coincide here.
      if (this.isAcknowledged.isPending()) {
        this.acknowledged = true
        this.isAcknowledged.resolve(this)
      }
      // isPersisted is the same Deferred, so this resolves both.
      this.isSettled.resolve(this)
    } catch (error) {
      // Preserve the original error for rethrowing
      const originalError =
        error instanceof Error ? error : new Error(String(error))

      // Update transaction with error information
      this.error = {
        message: originalError.message,
        error: originalError,
      }

      // rollback the transaction
      this.rollback()

      // Re-throw the original error to preserve identity and stack
      throw originalError
    }

    return this
  }

  /**
   * Compare two transactions by their createdAt time and sequence number in order
   * to sort them in the order they were created.
   * @param other - The other transaction to compare to
   * @returns -1 if this transaction was created before the other, 1 if it was created after, 0 if they were created at the same time
   */
  compareCreatedAt(other: Transaction<any>): number {
    const createdAtComparison =
      this.createdAt.getTime() - other.createdAt.getTime()
    if (createdAtComparison !== 0) {
      return createdAtComparison
    }
    return this.sequenceNumber - other.sequenceNumber
  }
}

export type { Transaction }
