# Proposal: acknowledged + settled — surfacing the two confirmations of an optimistic write

**Status:** Draft for discussion
**Scope:** `@tanstack/db` (additive: setters + new signals; soft-deprecates one name)
**Anti-goal:** any new `TransactionState`, or breaking/behavior changes.

## The Missing Step

An optimistic mutation against a backend with realtime sync has **two** confirmations:

- **acknowledged** — the server accepted the write (the POST/RPC resolved; a write id is known).
- **synced** — the write came back through sync, so the optimistic overlay can be dropped with no flicker.

Today both are awaited inside one handler, so every UI signal (`$synced`, `isPersisted`) flips only when the
write has fully synced back. But for most UIs the **acknowledgement is the signal that matters** — once the
server has the write, drop the spinner.

The DB library already tracks the acknowledged state internally (`recomputeOptimisticState` separates
active-from-completed overlays, `packages/db/src/collection/state.ts:465`); it just isn't exposed, so
maintainers writing realtime collections end up modeling a binary `pending/synced`, resulting in UIs that
wait longer than they have to to drop pending state and fire success messages or transitions.

## The design

Additive. The only name that changes is `isPersisted` — see "naming" below.

| signal | fires when | meaning |
| ------ | ---------- | ------- |
| `tx.isAcknowledged` / `$acknowledged` | acknowledged | server has the write |
| `tx.isSettled` | synced | echo received, overlay dropped (exact alias of the deprecated `isPersisted`) |
| `$synced` | synced | row reflects the backend (unchanged) |

Plus tools for the collection-maker to adopt the pattern:

- `transaction.acknowledge()` — setter, called at acknowledgement at any point in the handler; flips
  `isAcknowledged` / `$acknowledged` while keeping the handler unresolved (as we currently do).
- `transaction.settleWith(p)` — lets the handler return early (upon acknowledgement) while the framework
  holds the overlay until the sync comes through, then resolves `isSettled` / `isPersisted`.

(For side-effects at either milestone — toasts, navigation — await `tx.isAcknowledged` / `tx.isSettled`;
no new callback surface is added.)

The `settleWith` form is the preferred pattern, but it asks maintainers to change their mental model a little,
so the imperative `acknowledge()` one-liner exists too — it exposes the acknowledged-not-synced state with the
smallest possible change.

## Before / after (collection-maker code)

An example using the Electric SQL DB Collection, showing how its insert handler changes:

```ts
// BEFORE — both confirmations awaited in the handler; the acknowledgement is invisible
const wrappedOnInsert = async ({ transaction, ...p }) => {
  const result = await appHandlers.onInsert({ transaction, ...p }) // acknowledged
  await processMatchingStrategy(result)                            // synced (blocks)
  return result
}
```

```ts
// AFTER (a) — the one-line imperative transaction.acknowledge()
const wrappedOnInsert = async ({ transaction, ...p }) => {
  const result = await appHandlers.onInsert({ transaction, ...p }) // acknowledged
  transaction.acknowledge()                                        // ← flips $acknowledged NOW
  await processMatchingStrategy(result)                            // synced (still blocks)
  return result
}
```

```ts
// AFTER (b) — free the handler; framework owns settlement; still non-breaking
const wrappedOnInsert = async ({ transaction, ...p }) => {
  const result = await appHandlers.onInsert({ transaction, ...p }) // acknowledged
  transaction.acknowledge()
  transaction.settleWith(() => processMatchingStrategy(result))    // synced, framework-held
  return result   // returns at the ack; isAcknowledged fires; isSettled/isPersisted still fire at sync
}
```

## What changes, by who you are

- **Plain collection / no echo:** nothing.
- **User of a realtime collection, maker hasn't adopted:** nothing.
- **User of a realtime collection, maker adopted:** your existing `isPersisted` / `$synced` behave
  **identically**. Opt in to snappier behavior by reading the new `$acknowledged` / awaiting `tx.isAcknowledged`.
- **Collection-maker:** add `acknowledge()`, or switch to `settleWith()`. Your users feel zero behavioral
  change unless they change code to use the new flags.

App developer, snappy toast — fully opt-in:

```ts
const tx = todos.insert(draft)
await tx.isAcknowledged   // fires at the ack if your collection adopted; never later than isSettled
toast.success(`Saved`)
```

Reactive, three phases:

```ts
const label =
  !row.$acknowledged ? `Saving…`
  : !row.$synced     ? `Saved`   // server has it; awaiting sync to echo
  :                    `Saved`   // fully synced, broadcast, settled
```

## Internals

The boundary already exists; we expose it:

| phase | internal store | `$acknowledged` | `$synced` |
| ----- | -------------- | --------------- | --------- |
| persisting | `optimisticUpserts` (active tx) | false | false |
| acknowledged | `optimisticUpserts` (active tx) + `acknowledgedKeys` | true | false |
| synced | overlay dropped | true | true |

`acknowledge()` resolves `isAcknowledged` and marks the tx's keys acknowledged. `settleWith(p)` keeps the
transaction in `persisting` (so the overlay is held in the active path — no stale-drop, no flicker) until `p`
resolves, then settles and resolves `isSettled`/`isPersisted`. With no `settleWith`, `isSettled` resolves when
the handler returns — exactly as today.

## Naming: surgery on one word only

This PR touches exactly **one** existing name: `isPersisted`. It is defined operationally ("the handler
resolved"), so its timing was always ambiguous, and it was a *different word* from `$synced` for the *same*
milestone. We soft-deprecate it in favour of **`isSettled`** (kept as an exact alias — same value, same
resolve/reject moment). Everything that already uses "sync" or "settle" stays exactly as-is: `$synced` and
the new `settleWith` keep their words. This strictly reduces an existing confusion and adds nothing the team
has to relearn.

### A suggestion we are deliberately *not* acting on here

There is a reasonable argument that **"settled" is a better word than "synced" across the board** — including
for the row prop `$synced` → `$settled`. "Settled" names the *terminal* state ("fully resolved, no special
cases remain, forget it"), whereas "synced" describes the *mechanism*. The case is sharper than it looks:
the acknowledgement can itself carry synced data (servers often return the affected rows in the write
response), so "synced" is a little overloaded — data can be "synced" before the row is *settled*.

We **suggest** a future deprecation/rename of `$synced` → `$settled` for full parallelism
(`$acknowledged`/`isAcknowledged`, `$settled`/`isSettled`). But "sync" and "settle" are conceptually close
enough that it is fine to ship this PR **without** it — and `$synced` is a well-liked, accurate name, so the
churn of deprecating it is not obviously worth it. Flagging it for the maintainers to decide, separately.

## A more conservative companion

There is a **smaller companion proposal in a separate PR** that adds *only* `transaction.acknowledge()`,
`tx.isAcknowledged`, and `$acknowledged` — no `settleWith`, and it leaves `isPersisted` alone.
It buys the snappy-UI win with the absolute minimum surface. This proposal is the fuller version; pick the
trade-off the project prefers — the two are not meant to both land.

## Open question (either way)

A write that is **acknowledged but never echoes** (sync times out) currently rolls back an already-durable
write. `settleWith` gives the framework the hook to handle this more gracefully (e.g. surface a sync-failed
state instead of rolling back) — out of scope here, but worth deciding.
