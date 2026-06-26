# Proposal: expose the "acknowledged" state for optimistic mutations

**Status:** Draft for discussion
**Scope:** `@tanstack/db` (additive: one setter, one optional helper, new event-anchored signals)
**Non-goal:** a new `TransactionState`, or any forced behavior change.

## The gap

An optimistic mutation against a backend with realtime sync has **two** confirmations, not one:

- **acknowledged (A)** — the server accepted the write (the POST/RPC resolved; the write id is known).
- **settled (S)** — the write came back through sync, so the optimistic overlay can be dropped with no flicker.

Today both are awaited inside one handler, so every UI signal (`$synced`, `isPersisted`) flips only at **S**. But for most UIs **A is the signal that matters** — once the server has the write, drop the spinner. The library already tracks A internally (`recomputeOptimisticState` separates active-from-completed overlays, `packages/db/src/collection/state.ts:465`); it just isn't exposed.

## The design: anchor names to events, not to handler timing

`isPersisted` means "the handler resolved" — an *operational* definition, which is why its timing is ambiguous. We add two signals defined by the two physical events instead, identical in every collection forever:

| signal | fires at | meaning |
| ------ | -------- | ------- |
| `tx.isAcknowledged` / `$acknowledged` | **A** | server has the write |
| `tx.isSettled` / `$settled` | **S** | echo received, overlay dropped |

`isPersisted` / `$synced` become **deprecated aliases of the settled pair** — exact synonyms, zero behavior change (`$synced` already *is* event S). This also gives parallel naming: `$acknowledged`/`isAcknowledged`, `$settled`/`isSettled`.

Plus two tools for the collection-maker:

- `transaction.acknowledge()` — setter, called at A.
- `transaction.settleWith(p)` — optional; lets the handler return early while the framework holds the overlay and pins `isSettled` to S.

## Before / after (collection-maker code)

`wrappedOnInsert` lives in the realtime-collection adapter (e.g. `packages/electric-db-collection/src/electric.ts`). It wraps the app developer's `onInsert`.

```ts
// BEFORE — both confirmations awaited in the handler; A is invisible
const wrappedOnInsert = async ({ transaction, ...p }) => {
  const result = await appHandlers.onInsert({ transaction, ...p }) // A
  await processMatchingStrategy(result)                            // S (blocks)
  return result                                                    // isPersisted at S
}
```

```ts
// AFTER (depth 1) — one added line; non-breaking; exposes A
const wrappedOnInsert = async ({ transaction, ...p }) => {
  const result = await appHandlers.onInsert({ transaction, ...p }) // A
  transaction.acknowledge()                                        // ← flips $acknowledged NOW
  await processMatchingStrategy(result)                            // S (still blocks)
  return result                                                    // isPersisted STILL at S — unchanged
}
```

```ts
// AFTER (depth 2) — also free the handler; framework owns the settle; still non-breaking
const wrappedOnInsert = async ({ transaction, ...p }) => {
  const result = await appHandlers.onInsert({ transaction, ...p }) // A
  transaction.acknowledge()                                        // A
  transaction.settleWith(() => processMatchingStrategy(result))    // S, framework-held
  return result   // returns at A; isAcknowledged fires; isSettled/isPersisted still pinned to S
}
```

## Adoption is a depth slider, not a breaking/non-breaking fork

The consumer vocabulary is **identical at every depth** — `isAcknowledged` always means A, `isSettled` always means S:

| depth | maker does | handler returns at | `isAcknowledged` (=A) | `isSettled` (=S) | break? |
| ----- | ---------- | ------------------ | --------------------- | ---------------- | ------ |
| 0 — legacy | nothing | S | coincides with S | S | no |
| 1 | `acknowledge()` | S (blocks) | **A** (snappy) | S | no |
| 2 | `acknowledge()` + `settleWith()` + early return | A | **A** | S (framework-held) | no |
| 3 — opinionated | depth 2, *and* alias their local `isPersisted`→A | A | A | S | yes (their call) |

Depth 2 already delivers full snappiness with no break: `settleWith` frees the handler *and* keeps `isSettled`/`isPersisted` pinned to S, while `isAcknowledged` carries the win. Depth 3 (overloading `isPersisted` to be snappy-by-default) is an optional opinion; its divergence is quarantined inside the deprecated `isPersisted` alias.

## What changes, by who you are

- **Plain collection / no echo:** nothing.
- **Realtime collection, maker hasn't adopted:** nothing.
- **Realtime collection, maker adopted:** your existing `isPersisted` / `$synced` behave **identically**. Opt into snappiness by reading the new `$acknowledged` / awaiting `tx.isAcknowledged`. Reach for `tx.isSettled` only when you specifically need "fully reconciled."
- **Collection-maker:** add `acknowledge()` (depth 1), optionally `settleWith()` (depth 2). Your users feel zero behavioral change.

App developer, snappy toast — fully opt-in:

```ts
const tx = todos.insert(draft)
await tx.isAcknowledged   // fires at A if your collection adopted; never later than isSettled
toast.success(`Saved`)
```

Reactive, three phases:

```ts
const label =
  !row.$acknowledged ? `Saving…`
  : !row.$settled    ? `Saved`   // server has it; quietly reconciling
  :                    `Saved`   // fully settled
```

**Migration bedrock:** a dev who moves off `isPersisted`/`$synced` onto `isAcknowledged`/`isSettled` is permanently insulated from whatever depth their collection-maker chooses, now or later. Snappiness is opt-in via a stable name, so it is never retracted.

## Internals

Three overlay phases already exist; we expose the boundaries:

| phase | internal store | `$acknowledged` | `$settled` |
| ----- | -------------- | --------------- | ---------- |
| persisting | `optimisticUpserts` (active tx) | false | false |
| acknowledged | `pendingOptimistic*` (+ a settle-pending set when `settleWith` is used) | true | false |
| settled | overlay dropped | true | true |

`acknowledge()` resolves `isAcknowledged` and marks the tx's keys acknowledged. `settleWith(p)` adds the tx to a settle-pending set so its overlay is retained until `p` resolves (instead of being dropped as stale, `state.ts:544-580`), then drops it → `isSettled` resolves. With no `settleWith`, `isSettled` resolves when the handler returns — exactly as today.

## Open questions

1. **Non-echo collections:** `isAcknowledged` coincides with `isSettled` (no separate ack). OK?
2. **`settleWith` home:** generic `Transaction` capability vs adapter-only. (Overlay-hold is generic; the trigger is adapter-specific.)
3. **Settle-timeout:** if acknowledged but never echoed, reject `isSettled` / re-mark / leave to consumer? (`awaitTxId` currently times out at 5s and rolls back an already-durable write — arguably the real bug `settleWith` lets us fix.)
4. **Rename scope:** `$synced`→`$settled` / `isPersisted`→`isSettled` is cosmetic (synonyms + soft-deprecate). Ship the rename for parallel naming, or keep old names?
