# Proposal: expose the "acknowledged" state for optimistic mutations (minimal)

**Status:** Draft for discussion
**Scope:** `@tanstack/db` (additive: one setter + one virtual property)
**Anti-goal:** any new `TransactionState`, any rename or deprecation, any breaking/behavior change.

## The Missing Step

An optimistic mutation against a backend with realtime sync has **two** confirmations:

- **acknowledged (A)** — the server accepted the write (the POST/RPC resolved; a write id is known).
- **settled (S)** — the write came back through sync, so the optimistic overlay can be dropped with no flicker.

Today both are awaited inside one handler, so every UI signal (`$synced`, `isPersisted`) flips only at **S**.
But for most UIs **A is the signal that matters** — once the server has the write, drop the spinner.

The DB library already tracks A internally (`recomputeOptimisticState` separates active-from-completed
overlays, `packages/db/src/collection/state.ts:465`); it just isn't exposed, so maintainers writing realtime
collections end up modeling a binary `pending/synced`, and UIs wait longer than they have to before dropping
pending state and firing success messages or transitions.

## The design: one setter, one virtual property

Purely additive. `isPersisted` and `$synced` keep their exact meaning and timing — **nothing is renamed or
deprecated, and the optimistic overlay is untouched.** We add:

| new signal | true / resolves at | meaning |
| ---------- | ------------------ | ------- |
| `tx.isAcknowledged` | **A** | server has the write. Resolves together with `isPersisted` if the collection never acks; rejects on failure. Always safe to await, never later than `isPersisted`. |
| `$acknowledged` | **A** | server has the write; always `true` when `$synced` is `true`. |

Plus one tool for the collection-maker:

- `transaction.acknowledge()` — a no-op-safe setter the adapter calls when the server confirms the write.
  It flips `isAcknowledged` / `$acknowledged` and keeps the handler unresolved exactly as today.

## Before / after (collection-maker code)

An example using the Electric SQL DB Collection, showing how its insert handler changes:

```ts
// BEFORE — both confirmations awaited in the handler; A is invisible
const wrappedOnInsert = async ({ transaction, ...p }) => {
  const result = await appHandlers.onInsert({ transaction, ...p }) // A
  await processMatchingStrategy(result)                            // S (blocks)
  return result                                                    // isPersisted at S
}
```

```ts
// AFTER — one added line; non-breaking
const wrappedOnInsert = async ({ transaction, ...p }) => {
  const result = await appHandlers.onInsert({ transaction, ...p }) // A
  transaction.acknowledge()                                        // ← flips $acknowledged NOW
  await processMatchingStrategy(result)                            // S (still blocks)
  return result                                                    // isPersisted STILL at S — unchanged
}
```

## What changes, by who you are

- **Plain collection / no echo:** nothing.
- **User of a realtime collection, maker hasn't adopted:** nothing.
- **User of a realtime collection, maker adopted:** your existing `isPersisted` / `$synced` behave
  **identically**. Opt in to snappier behavior by reading the new `$acknowledged` / awaiting `tx.isAcknowledged`.
- **Collection-maker:** add one `acknowledge()` call. Your users feel zero behavioral change unless they
  change code to read the new signal.

App developer, snappy toast — fully opt-in:

```ts
const tx = todos.insert(draft)
await tx.isAcknowledged   // fires at A if your collection adopted; never later than isPersisted
toast.success(`Saved`)
```

Reactive, three phases:

```ts
const label =
  !row.$acknowledged ? `Saving…`
  : !row.$synced     ? `Saved`   // server has it; awaiting sync to echo
  :                    `Saved`   // fully settled, broadcast, sync'd
```

## Internals

The boundary already exists; we expose it:

| phase | internal store | `$acknowledged` | `$synced` |
| ----- | -------------- | --------------- | --------- |
| persisting (not acked) | `optimisticUpserts` (active tx) | false | false |
| acknowledged | `optimisticUpserts` (active tx) + `acknowledgedKeys` | true | false |
| synced | overlay dropped | true | true |

`acknowledge()` resolves `isAcknowledged`, marks the tx's keys in `acknowledgedKeys`, and emits a
virtual-prop-only update so subscribers react. The handler still blocks on the echo, so `isPersisted` and
`$synced` resolve exactly when they do today.

## Scope — and a more comprehensive companion (PR #3)

This proposal is deliberately the **minimal, lowest-churn** version: it adds only `transaction.acknowledge()`,
`tx.isAcknowledged`, and `$acknowledged`. It renames nothing and deprecates nothing, so `isPersisted` /
`$synced` are byte-for-byte unchanged and there is almost no new surface to learn.

There is a **companion proposal in a separate PR (#3)** that goes further:

- adds `transaction.settleWith()` so a handler can return at the ack and let the framework own the sync
  wait, and
- soft-deprecates `isPersisted` in favour of `isSettled` (kept as an exact alias), fixing the one
  operationally-defined name. (It keeps `$synced`, and only *suggests* a future `$synced`→`$settled` rename.)

That version is more capable and still additive / non-breaking — but it adds more surface and touches an
existing name. This PR exists as the conservative option that buys the snappy-UI win with the smallest
possible change. Pick whichever trade-off the project prefers; the two are not meant to both land.
