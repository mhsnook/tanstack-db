---
'@tanstack/db': minor
---

Add first-class support for the "accepted" checkpoint in the transaction lifecycle, making the three-step write → accept → settle journey observable from outside the `mutationFn`.

Realtime/txid-echo sync adapters typically have three meaningful moments: the optimistic write, the server durably accepting it (e.g. a 200 with an assigned sequence number), and the change finally echoing back over the sync stream. Previously only the first and last were observable — the middle "accepted" checkpoint lived entirely inside the `mutationFn` closure.

A `mutationFn` can now report acceptance with `transaction.setAccepted()`, which transitions the transaction to a new `accepted` state (a sub-phase of `persisting`) and resolves `transaction.isAccepted.promise`. The optimistic overlay stays applied during `accepted` — it still only drops when the `mutationFn` resolves — so this enables a flicker-free "saved ✓ · syncing…" window. Transactions also gain `transaction.onStateChange(listener)` to observe every state transition.

This is fully backward-compatible:

- The new `accepted` state is treated exactly like `persisting` everywhere in the collection/sync layer, so a `mutationFn` that never calls `setAccepted()` behaves exactly as before.
- `isAccepted` always settles no later than `isPersisted`: it auto-resolves at completion if acceptance was never reported (so consumers awaiting it never hang) and rejects alongside `isPersisted` on rollback.

```ts
const tx = createTransaction({
  mutationFn: async ({ transaction }) => {
    const ack = await api.send(transaction.mutations) // server 200
    transaction.setAccepted()                         // overlay still held
    await api.waitForSync(ack.txid)                   // wait for the echo
    // mutationFn resolves -> completed -> overlay drops onto synced row
  },
})

await tx.isAccepted.promise  // durably accepted, sync echo pending
await tx.isPersisted.promise // fully settled
```
