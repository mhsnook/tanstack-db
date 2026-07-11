# Partition-scoped Supabase realtime on a TanStack DB query collection

**Audience:** the app codebase (a Supabase project) that wants live data on top
of a `queryCollectionOptions` collection running in **on-demand** mode — built
in-app first, extracted into a library later.

**Context:** this fork (`mhsnook/tanstack-db`) has been building
predicate-aware loading for query collections:

- **Level 2 (shipped on `claude/partition-aware-inclusion`):** load-by-key
  requests served from already-present rows.
- **Level 3 (design stage):** subset queries served from live *covering*
  queries — see
  [`PREDICATE-INCLUSION-DESIGN.md`](https://github.com/mhsnook/tanstack-db/blob/claude/partition-aware-inclusion/packages/query-db-collection/PREDICATE-INCLUSION-DESIGN.md)
  on that branch.

The idea: the collection already tracks, per live query, a compiled predicate
(`LoadSubsetOptions.where`). Those same predicates drive **which realtime
subscriptions are open at any moment** — one per live partition, opened when
the predicate loads, closed when it unloads.

## 0. The design in one paragraph, and the verdict

Almost everything here is **transport-independent**: extracting partitions
from predicates, the subscription lifecycle, the join-gap buffering, the
ingest rules, reconnect handling. That's the bridge core (§2–§3), and it's
where all the interesting decisions live. The transport — Supabase broadcast
vs. `postgres_changes` — is a ~20-line adapter behind a 3-method interface
(§4). **Recommended default: the broadcast adapter (§4.1).** For public-facing
fan-out it is correct by construction (the trigger controls fan-out, so
partition-departures and deletes just work) and it's the substrate Supabase
scales; its cost is one ~30-line SQL migration. The `postgres_changes` adapter
(§4.2) needs no SQL, but is only fully correct with `REPLICA IDENTITY FULL`
plus a companion unfiltered-UPDATE subscription — two workarounds to reach the
behavior broadcast gives you for free. Use it if you want to defer migrations
while messing around; nothing in the core changes when you swap.

**You can build all of this in the app with zero fork/library changes.** The
seams in §1 are public API today.

---

## 1. The public seams (no library changes needed)

### 1.1 Seeing predicates as they load: `ctx.meta.loadSubsetOptions`

In on-demand mode, every fetch the collection makes calls **your** `queryFn`,
and the compiled predicate rides along on the query meta
([query.ts#L1095](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/query-db-collection/src/query.ts#L1095)):

```ts
queryFn: async (ctx) => {
  const opts = ctx.meta?.loadSubsetOptions as LoadSubsetOptions | undefined
  // opts.where is a BasicExpression<boolean> — a walkable tree:
  // { type: 'func', name: 'eq', args: [{ type: 'ref', path: ['language'] }, { type: 'val', value: 'hin' }] }
  ...
}
```

`LoadSubsetOptions` is defined at
[types.ts#L287](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/db/src/types.ts#L287)
(`where`, `orderBy`, `limit`, `cursor`, `offset`). This is the **subscribe
hook**: derive the partition, join *before* running the select (§3.2).

### 1.2 Seeing predicates unload: QueryCache `removed` events

Each distinct predicate becomes its own TanStack Query cache entry (the
serialized predicate is appended to your `queryKey`,
[query.ts#L1056](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/query-db-collection/src/query.ts#L1056)).
When the collection GCs an idle predicate it removes that entry from the
QueryClient
([query.ts#L1672](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/query-db-collection/src/query.ts#L1672)),
which the QueryCache broadcasts:

```ts
queryClient.getQueryCache().subscribe((event) => {
  if (event.type === `removed` && isOurKey(event.query.queryKey)) {
    bridge.release(event.query.queryHash)
  }
})
```

`queryFn`-open + `removed`-close is a complete, lifecycle-correct
loaded/unloaded predicate stream — the in-app stand-in for the level-3
`loadedPredicates` registry.

### 1.3 Pushing realtime events in: the manual write utils

`collection.utils` exposes `writeInsert` / `writeUpdate` / `writeUpsert` /
`writeDelete` / `writeBatch` and `refetch`
([manual-sync.ts#L244](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/query-db-collection/src/manual-sync.ts#L244)),
built exactly for "rows arrive over a websocket". Writes go straight into the
synced store — no refetch round-trip.

---

## 2. Partitions, not predicates, are the subscription unit

Realtime transports can't express arbitrary predicate trees (broadcast has
opaque topics; `postgres_changes` takes one single-column filter). Trying to
push the whole `where` into the transport is the wrong goal. Instead:

**Declare partition axes** per collection — the columns whose equality clauses
define a "region" of the table:

```ts
partitionBy: ['language']   // → partitions like { column: 'language', value: 'hin' }
```

The bridge walks each loading predicate's `where` for `eq(partitionCol, val)`
clauses (top-level or inside `and`) and subscribes at **partition
granularity**. Everything narrower rides for free:

- `language='hin' AND difficulty='hard'` subscribes to the `hin` partition.
  Incoming rows that match the partition but not the residual are still
  written to the collection — **that's correct, not sloppy**: the collection
  is the synced store, and live queries filter on read. The narrow query
  simply doesn't render them. No residual evaluation needed at ingest.
- A predicate with no partition clause (or `or` across partitions) gets no
  subscription — it still fetches and renders, it just isn't live. Err toward
  not subscribing rather than subscribing to the whole table.
- A predicate with a `limit` gets no subscription (a live insert can enter a
  top-N window, but a row dropping *out* of the window can't be evicted
  locally — mirrors the level-3 MVP rule of only matching unlimited covers).

This is deliberately the same declaration the level-3 inclusion gate needs
(`dedupeQueriesOn`): "these columns are honest partition axes." One config,
two consumers. And once level 3 lands, narrow queries stop creating observers
entirely, so the bridge naturally converges on one subscription per live
covering partition, with refcount pinning (design doc §5.3) making
subscription lifetime equal row retention — no bridge changes needed.

---

## 3. The bridge core (transport-independent, ~120 lines)

### 3.1 State

```ts
type Partition = { column: string; value: string }        // canonical key: `${column}=${value}`
type Live = { close: () => void; refs: number; buffer: Array<PartitionEvent> | null }

const live = new Map<string, Live>()                      // partition key → subscription
const partitionsByQueryHash = new Map<string, Array<string>>()
```

### 3.2 Lifecycle

```ts
queryFn: async (ctx) => {
  const opts = (ctx.meta?.loadSubsetOptions ?? {}) as LoadSubsetOptions
  const partitions = extractPartitions(opts)              // §2 rules
  partitionsByQueryHash.set(hashKey(ctx.queryKey), partitions.map(pKey))
  await Promise.all(partitions.map(acquire))              // ① subscribe first
  const rows = await selectFromSupabase(opts)             // ② then fetch
  partitions.forEach(drainBuffer)                         // ③ then apply buffered events
  return rows
}
```

`acquire` refcounts by partition key; on first acquire it calls
`transport.open(partition, ingest, onResubscribe)` (§4 interface) with the
buffer armed. `release` (driven by the QueryCache `removed` event, §1.2)
decrements and closes at zero. `selectFromSupabase` translates `opts.where`
to PostgREST filters (`.eq()`, `.gte()`, …) by walking the expression tree —
same translation the fork's siblings do for their backends (electric's
`compileSQL`, powersync's `sqlite-compiler`); implement `eq`/`and` + the
comparison ops and throw on anything else until you need it.

### 3.3 Ingest — one rule, consulting *all* live partitions

All transports normalize events to:

```ts
type PartitionEvent =
  | { op: 'INSERT' | 'UPDATE'; row: Row }
  | { op: 'DELETE'; oldRow: Partial<Row> }   // at least the primary key
```

```ts
function ingest(partitionKey: string, e: PartitionEvent) {
  const sub = live.get(partitionKey)
  if (sub?.buffer) { sub.buffer.push(e); return }
  const { writeUpsert, writeDelete } = collection.utils
  if (e.op === `DELETE`) {
    if (collection.has(getKey(e.oldRow))) writeDelete(getKey(e.oldRow))
  } else if (matchesAnyLivePartition(e.row)) {   // NOT just this partition
    writeUpsert(e.row)
  } else if (collection.has(getKey(e.row))) {
    writeDelete(getKey(e.row))                   // row left every live region
  }
}
```

Checking against **all** live partitions (a few string comparisons) handles
two edge cases with one rule: a row moving `hin → fra` while both partitions
are live is upserted, not deleted; and with multiple partition axes (say
`language` and `deck_id`), a row leaving one axis's region isn't dropped while
another live region still contains it. Duplicate delivery (a move seen by both
the old and new partition's subscriptions, or replays after rejoin) is
harmless: upsert/delete by key is idempotent — which is also why it must be
`writeUpsert`, not `writeInsert` (which throws on existing keys).

### 3.4 Join gap and reconnects

No realtime transport replays missed events, so two rules:

- **Join gap:** the ① subscribe → ② fetch → ③ drain ordering above, with
  events buffered per-partition until the initial select lands, closes the
  window where a change commits after the select executes but before the
  subscription is active. After drain, `buffer = null` and events apply
  immediately.
- **Reconnects:** supabase-js rejoins channels automatically, but the gap is
  lossy. When the transport signals a re-join (`onResubscribe`), re-arm the
  buffer and refetch the queries pinned to that partition
  (`queryClient.invalidateQueries` by the recorded query hashes, or
  `collection.utils.refetch()` for the blunt version), then drain.

---

## 4. Transport adapters

The only transport-specific code:

```ts
interface RealtimeTransport {
  open(
    p: Partition,
    onEvent: (e: PartitionEvent) => void,
    onResubscribe: () => void,   // fired on re-join after a dropped connection
  ): Promise<() => void>          // resolves once subscribed; returns close()
}
```

### 4.1 Broadcast adapter — recommended default

Partition → topic string: `words:language:hin`. Client side:

```ts
const channel = supabase.channel(`words:${p.column}:${p.value}`, { config: { private: true } })
channel.on(`broadcast`, { event: `*` }, ({ payload }) =>
  onEvent(normalize(payload)))    // payload: { operation, record, old_record, ... } — verify shape
await joined(channel)             // subscribe(); resolve SUBSCRIBED, reject CHANNEL_ERROR/TIMED_OUT
```

Server side, one generic trigger function reused by every partitioned table —
this is the piece that makes broadcast correct by construction, because *you*
control the fan-out: when a partition column changes, it notifies **both** the
old and new partition, and DELETE events carry the full old row:

```sql
create or replace function public.broadcast_partition_changes()
returns trigger
security definer
language plpgsql
set search_path = ''
as $$
declare
  col text := tg_argv[0];
  new_val text := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new)->>col end;
  old_val text := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old)->>col end;
  base text := tg_table_name || ':' || col || ':';
begin
  if new_val is not null then
    perform realtime.broadcast_changes(base || new_val, tg_op, tg_op,
      tg_table_name, tg_table_schema, new, old);
  end if;
  if old_val is not null and old_val is distinct from new_val then
    perform realtime.broadcast_changes(base || old_val, tg_op, tg_op,
      tg_table_name, tg_table_schema, new, old);
  end if;
  return null;
end;
$$;

create trigger words_partition_broadcast
  after insert or update or delete on public.words
  for each row execute function public.broadcast_partition_changes('language');
```

Authorization is one RLS policy on `realtime.messages` (private channels check
it at **join time**, once per subscriber — not per event, which is why this
substrate scales):

```sql
create policy "public can listen to words partitions"
  on realtime.messages for select
  to anon, authenticated
  using (extension = 'broadcast' and realtime.topic() like 'words:language:%');
```

The topic namespace is the authorization boundary — never broadcast a topic
pattern wider than the policy. If some partitions are non-public, encode that
in the policy, not the client.

Why this is the default for a public-facing app: departures and deletes are
handled in the trigger (no client workarounds), join-time authz + cheap
fan-out is the mechanism Supabase recommends at scale, and the payload is
yours to slim down later if whole rows get heavy. Total cost: the migration
above.

### 4.2 `postgres_changes` adapter — zero-SQL alternative

Partition → filter string: `language=eq.hin`. The predicate feeds the
subscription literally:

```ts
channel.on(`postgres_changes`,
  { event: `*`, schema: `public`, table: `words`, filter: `${p.column}=eq.${p.value}` },
  (payload) => onEvent(normalize(payload)))   // { eventType, new, old }
```

No migration, and per-subscriber RLS means your existing `anon` select policy
does double duty. But two delivery gaps need patching before it's equivalent:

1. **Filtered DELETEs are silently dropped by default.** DELETE filters match
   against the *old* record, which only carries the primary key under the
   default replica identity — `language=eq.hin` can never match, so deleted
   rows linger. Fix: `alter table public.words replica identity full;`
   (extra WAL on writes to that table — so much for "zero SQL").
2. **Departures are invisible to the old partition.** UPDATE filters match the
   *new* record only. Fix: the adapter registers **one** shared unfiltered
   UPDATE-only subscription per table, feeding the same `ingest` — the §3.3
   rule (held? matches any live partition?) already does the right thing with
   it. Cost: every update on the table reaches every client.
3. Scale ceiling: the realtime server evaluates each change against every
   subscriber's filters and RLS. Fine for a prototype or modest traffic;
   it's the part that falls over first under public fan-out.

Legitimate uses: local dev before the migration lands, or tables where
partition columns are immutable and deletes don't happen (then neither gap
applies and it's genuinely free). Otherwise the two patches cost more than
the broadcast trigger they're imitating.

---

## 5. Transport-independent gotchas (from auditing the library internals)

1. **Realtime-written rows are unowned.** On-demand mode tracks which query
   loaded each row and GCs rows when their last owning query unloads. The
   manual write utils do **not** register ownership (verified in
   `manual-sync.ts`), so a row upserted from a realtime event survives its
   partition unloading — a small retention leak, never wrong data. Fine for
   the prototype; the library fix is letting write utils attribute rows to an
   owner. Don't "fix" it by deleting on release — the row may be owned by
   another live query.
2. **Limits/orderBy don't compose with live events** — hence the §2 rule:
   no subscription for limited predicates.
3. **Filter/topic value encoding.** Partition values become topic segments or
   filter strings. Keep them to slugs/ids; if a value can contain `:`  `,` or
   parens, encode it (and mirror the encoding in the trigger).

---

## 6. What graduates into the library later

- **Registry event surface.** The level-3 `loadedPredicates` registry (design
  doc §5.2) should expose `onPredicateLoaded/onPredicateUnloaded` — then the
  bridge stops spying on the QueryCache and becomes a plain subscriber. This
  prototype is the first consumer and will tell us what those events need to
  carry.
- **Unified partition config.** `partitionBy` here and the inclusion gate's
  `dedupeQueriesOn` are the same declaration; one config key, two consumers.
- **Row ownership for pushed writes** (gotcha #1).
- **The transport interface itself.** `RealtimeTransport` is the shape a
  future `supabase-db-collection` (or any websocket-backed collection) wants;
  the two adapters are its first implementations.

---

## 7. Quick-reference: fork pointers

Pinned to [`816b667`](https://github.com/mhsnook/tanstack-db/tree/816b667c66c25be5266dbb958a91e2e02e8b53a1) (current main):

| What | Where |
|------|-------|
| `LoadSubsetOptions` (`where` is `BasicExpression`) | [db/src/types.ts#L287](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/db/src/types.ts#L287) |
| predicate attached to query meta | [query-db-collection/src/query.ts#L1095](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/query-db-collection/src/query.ts#L1095) |
| predicate appended to queryKey (on-demand) | [query-db-collection/src/query.ts#L1056](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/query-db-collection/src/query.ts#L1056) |
| cache entry removed on predicate GC | [query-db-collection/src/query.ts#L1672](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/query-db-collection/src/query.ts#L1672) |
| manual write utils | [query-db-collection/src/manual-sync.ts#L244](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/query-db-collection/src/manual-sync.ts#L244) |
| `compileExpression` (public, if full-predicate checks are ever needed) | [db/src/query/compiler/evaluators.ts#L89](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/db/src/query/compiler/evaluators.ts#L89) |
| expression→backend-filter precedent | [electric `compileSQL`](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/electric-db-collection/src/electric.ts#L479), [powersync `sqlite-compiler`](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/powersync-db-collection/src/sqlite-compiler.ts) |
| level-3 inclusion design | [PREDICATE-INCLUSION-DESIGN.md](https://github.com/mhsnook/tanstack-db/blob/claude/partition-aware-inclusion/packages/query-db-collection/PREDICATE-INCLUSION-DESIGN.md) (branch `claude/partition-aware-inclusion`) |
