---
'@tanstack/db': minor
---

Expose an `acknowledged` state for optimistic mutations, sitting between the optimistic write and the settled (synced-back) state. A write against a realtime-sync backend has two confirmations — the server accepting the write (acknowledged) and the change echoing back through sync (settled) — and this surfaces the earlier one so UIs can react sooner (e.g. drop a spinner) without waiting for the echo.

Additive and non-breaking; `isPersisted` / `$synced` are unchanged.

- `Transaction.acknowledge()` — a no-op-safe setter a collection adapter calls when the server confirms a write.
- `Transaction.isAcknowledged` — resolves at the ack; resolves together with `isPersisted` when no adapter calls `acknowledge()`; rejects on failure. Never resolves later than `isPersisted`.
- `$acknowledged` virtual property — `true` once acknowledged, always `true` when `$synced` is `true`. Wired through row enrichment, the virtual-prop cache, and group-by aggregation, and emitted as a virtual-prop-only update when it flips mid-flight.
