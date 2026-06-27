import { describe, expect, it } from 'vitest'
import { createCollection } from '../src/collection/index.js'

const waitForChanges = () => new Promise((resolve) => setTimeout(resolve, 10))

type Row = { id: string; value: string }

function createGate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe(`Transaction.settleWith() + isSettled — the settle layer`, () => {
  it(`returns the handler at the ack, holds the overlay, and settles when the framework-owned step resolves`, async () => {
    const settleGate = createGate()
    let syncFns:
      | {
          begin: () => void
          write: (c: { type: `insert`; value: Row }) => void
          commit: () => void
        }
      | undefined

    const collection = createCollection<Row, string>({
      id: `settle-with`,
      getKey: (item) => item.id,
      sync: {
        sync: ({ begin, write, commit, markReady }) => {
          syncFns = { begin, write, commit }
          markReady()
        },
      },
      onInsert: async ({ transaction }) => {
        // Ack now; hand the settle to the framework and return immediately.
        transaction.acknowledge()
        transaction.settleWith(() => settleGate.promise)
      },
    })

    const subscription = collection.subscribeChanges(() => {}, {
      includeInitialState: false,
    })

    const tx = collection.insert({ id: `r1`, value: `v` })
    await tx.isAcknowledged.promise
    await waitForChanges()

    // Handler returned at the ack, but the transaction is still persisting and
    // neither settled milestone has resolved.
    expect(tx.acknowledged).toBe(true)
    expect(tx.state).toBe(`persisting`)
    expect(tx.isSettled.isPending()).toBe(true)
    expect(tx.isPersisted.isPending()).toBe(true)

    // The optimistic overlay is held: the row is visible, acknowledged, not synced.
    const held = collection.state.get(`r1`)
    expect(held?.$acknowledged).toBe(true)
    expect(held?.$synced).toBe(false)

    // The change syncs back, then the settle step resolves.
    syncFns!.begin()
    syncFns!.write({ type: `insert`, value: { id: `r1`, value: `v` } })
    syncFns!.commit()
    settleGate.release()

    await tx.isSettled.promise
    await tx.isPersisted.promise
    await waitForChanges()

    expect(tx.state).toBe(`completed`)
    const settled = collection.state.get(`r1`)
    expect(settled?.$synced).toBe(true)
    expect(settled?.$acknowledged).toBe(true)

    subscription.unsubscribe()
  })

  it(`rejects isSettled and isPersisted (and rolls back) when the settle step fails`, async () => {
    const collection = createCollection<Row, string>({
      id: `settle-fail`,
      getKey: (item) => item.id,
      sync: {
        sync: ({ markReady }) => markReady(),
      },
      onInsert: async ({ transaction }) => {
        transaction.acknowledge()
        transaction.settleWith(() => Promise.reject(new Error(`echo timeout`)))
      },
    })

    const tx = collection.insert({ id: `r1`, value: `v` })

    // The ack already happened and is not retracted.
    await expect(tx.isAcknowledged.promise).resolves.toBe(tx)
    await expect(tx.isSettled.promise).rejects.toThrow(`echo timeout`)
    await expect(tx.isPersisted.promise).rejects.toThrow(`echo timeout`)
    expect(tx.state).toBe(`failed`)
  })

  it(`isPersisted is the same Deferred as isSettled (cannot diverge)`, async () => {
    const collection = createCollection<Row, string>({
      id: `persisted-alias`,
      getKey: (item) => item.id,
      sync: { sync: ({ markReady }) => markReady() },
      onInsert: async () => {},
    })

    const tx = collection.insert({ id: `r1`, value: `v` })

    // Structural identity — same object, so they can never drift in value or timing.
    expect(tx.isPersisted).toBe(tx.isSettled)

    const [settled, persisted] = await Promise.all([
      tx.isSettled.promise,
      tx.isPersisted.promise,
    ])
    expect(settled).toBe(tx)
    expect(persisted).toBe(tx)
  })
})
