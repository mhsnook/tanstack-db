# Proposal: expose the "acknowledged, not yet echoed" state

**Status:** Draft for discussion
**Scope:** `@tanstack/db` (expose an internal sub-state), `@tanstack/electric-db-collection` (optional handler decoupling)
**Non-goal:** a new `TransactionState`.

## The shape

A transaction is `pending`, then either an **error** comes back, or one of two confirmations:

- **ack** — the server accepted the write (POST/RPC resolved; Electric: `txid` known).
- **echo** — the write came back through sync (Electric: `txid` seen in the stream).

If one confirmation is in, we await the other, then **settle** (drop the optimistic overlay). The four `TransactionState`s (`pending | persisting | completed | failed`) stay as-is. (Edge case for the framework, not the UI: ack arrives but echo times out — a settle-timeout, handled below.)

## Today everything settles on the echo

The Electric handler awaits **both** confirmations inside one `mutationFn`, so the transaction stays `persisting` until the echo lands — even when the ack came back much earlier (`packages/electric-db-collection/src/electric.ts`, `wrappedOnInsert` ~877):

```ts
const wrappedOnInsert = config.onInsert
  ? async (params) => {
      const handlerResult = await config.onInsert!(params) // ack: POST → { txid }
      await processMatchingStrategy(handlerResult)         // echo: awaitTxId(txid) — blocks here
      return handlerResult                                 // settles only after BOTH
    }
  : undefined
```

Every UI signal (`$synced`, `$origin`, `isPersisted`) therefore flips on the echo. But the ack is usually what the UI cares about: once the server has the write, it's safe — drop the spinner. The echo is mostly a framework concern (more so when the API already returns the affected rows). You can argue the UI is **more** correct following the ack than waiting for its own write to echo back.

## The library already tracks this

`recomputeOptimisticState` already separates **active** (still `persisting`) from **completed-but-not-yet-dropped** optimistic mutations (`packages/db/src/collection/state.ts:465`):

```ts
// completed tx → overlay moves to the "pending" maps (acknowledged, awaiting echo)
this.pendingOptimisticUpserts.set(mutation.key, mutation.modified) // state.ts:497
// active tx → overlay applied directly (not yet acknowledged)       state.ts:590+
```

That `pendingOptimistic*` set **is** the "acknowledged, not yet echoed" state. It's computed today; it just isn't exposed, and (because the handler blocks on the echo) it currently only fills at echo time. We want to expose it — and let it fill at ack time.

## What we expose

**a) A virtual prop so UIs respond to the ack, not the echo.** Additive, always `true` when `$synced` is `true`:

```ts
// packages/db/src/collection/state.ts (next to isRowSynced, ~160)
public isRowAcknowledged(key: TKey): boolean {
  if (this.isLocalOnly) return true
  if (this.isRowSynced(key)) return true
  return (
    (this.pendingOptimisticUpserts.has(key) || this.pendingOptimisticDeletes.has(key)) &&
    !this.hasActiveOptimisticMutation(key)
  )
}
```

```ts
// usage
!row.$acknowledged                   // spinner: server doesn't have it yet
 row.$acknowledged && !row.$synced   // solid, quietly reconciling
 row.$synced                         // settled
```

**b) A callback that fires on the ack** (doesn't wait for the echo), for snappy side-effects — navigation, toasts, clearing a form:

```ts
collection.onAcknowledged((tx) => { /* ack is in; echo may still be pending */ })
```

**c) Let handlers resolve at the ack and settle automatically on echo.** Instead of blocking the handler on `awaitTxId`, hand that wait to the framework, which holds the overlay until echo and drops it flicker-free:

```ts
const wrappedOnInsert = config.onInsert
  ? async (params) => {
      const handlerResult = await config.onInsert!(params)              // ack
      params.transaction.settleWith(() => processMatchingStrategy(handlerResult)) // echo, framework-owned
      return handlerResult   // resolves at ack → $acknowledged flips; overlay still held until echo
    }
  : undefined
```

This is the affordance for **moving logic out of the blocking handler**: anything you currently `await` after the POST purely to keep the overlay alive becomes a deferred settle step the framework runs. The handler closes at the ack; settle still happens.

## Open questions

1. **Non-Electric collections** (no separate echo): `$acknowledged` and `$synced` flip together — degrades to today's behavior. OK?
2. **`settleWith` home** — generic `Transaction` capability (overlay-hold is already generic) with Electric supplying the echo promise, vs Electric-only.
3. **Settle-timeout** — if acknowledged but never echoed, reject `isSettled` / re-mark the row / leave to consumer? (`awaitTxId` already has a 5s timeout.)
4. **Naming/backcompat** — if a handler resolves at ack, `isPersisted` resolves at ack too. Keep `isPersisted` = settled and add `isAcknowledged`?
