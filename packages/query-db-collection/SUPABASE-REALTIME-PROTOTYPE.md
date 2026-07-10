# Prototyping a Supabase-realtime bridge on a TanStack DB query collection

**Audience:** the app codebase (a Supabase project) that wants live data on top
of a `queryCollectionOptions` collection running in **on-demand** mode — built
in-app first, extracted into a library later.

**Mechanism:** classic realtime, i.e. `postgres_changes` subscriptions over the
websocket, with server-side filters (`language=eq.hin`). No triggers, no topic
conventions — the compiled predicate maps directly onto the subscription's
filter string.

**Context:** this fork (`mhsnook/tanstack-db`) has been building
predicate-aware loading for query collections:

- **Level 2 (shipped on `claude/partition-aware-inclusion`):** load-by-key
  requests served from already-present rows.
- **Level 3 (design stage):** subset queries served from live *covering*
  queries — see
  [`PREDICATE-INCLUSION-DESIGN.md`](https://github.com/mhsnook/tanstack-db/blob/claude/partition-aware-inclusion/packages/query-db-collection/PREDICATE-INCLUSION-DESIGN.md)
  on that branch.

The idea: the collection already tracks, per live query, a compiled predicate
(`LoadSubsetOptions.where`). Those same predicates can drive **which realtime
subscriptions are open at any moment** — one filtered subscription per live
partition, opened when the predicate loads, closed when it unloads. Once
level 3 lands, narrow subset queries never create their own observers, so the
only predicates that reach the network — and the only subscriptions you need —
are the broad partitions.

**Verdict from auditing the library internals: you can prototype this entirely
in the app, with zero fork/library changes.** The seams below are all public
API today.

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
(`where`, `orderBy`, `limit`, `cursor`, `offset`).

This is the **subscribe hook**: derive the realtime filter from `opts.where`,
join the channel *before* running the select, and you get subscribe-then-fetch
ordering for free (§3.3).

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
    releaseSubscriptionFor(event.query.queryHash)
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

### 1.4 Checking rows against a predicate: `compileExpression`

`@tanstack/db` publicly exports `compileExpression`
([evaluators.ts#L89](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/db/src/query/compiler/evaluators.ts#L89))
to turn a `BasicExpression` into an evaluator, for testing incoming rows
against the full `where` on ingest. For simple partitions,
`record[partitionCol] === value` is equivalent and simpler.

---

## 2. Predicate → filter mapping

`postgres_changes` accepts **one filter string per subscription binding**, on
**one column**: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`. No compound
`AND`/`OR` filters. So the mapping from a `where` tree is:

- **Single clause on a supported op** → direct translation:
  `eq(row.language, 'hin')` → `language=eq.hin`;
  `inArray(row.id, [1,2,3])` → `id=in.(1,2,3)`.
- **`and(...)` of clauses** → pick the clause on a **declared partition
  column**, subscribe on that alone (`language=eq.hin`), and apply the residual
  clauses client-side on ingest (§3.4). Subscribing slightly wide and
  filtering locally is correct; it just delivers a few extra events.
- **Anything else** (`or`, unsupported ops, no partition clause) → no
  subscription; the query still works, it just isn't live. Err toward not
  subscribing rather than subscribing to the whole table.

Declare the partition axes per collection (`['language']`), same declaration
the level-3 inclusion gate needs (`dedupeQueriesOn`) — one config, two
consumers.

**Scaling note, since this is public-facing:** the realtime server evaluates
every change against every subscriber's filters and RLS. Supabase itself steers
high-fan-out use toward broadcast for this reason. For a prototype and moderate
traffic `postgres_changes` is fine — just know the ceiling exists, and that the
bridge's *shape* (predicate in, subscription out) survives a later swap of
transport.

---

## 3. Client architecture

Four small pieces, ~150 lines total in-app.

### 3.1 Refcounted subscription manager

Multiple predicates can map to the same filter (e.g. the partition and a
narrow query over it, until level 3 exists). Key by the filter string:

```ts
type Sub = { channel: RealtimeChannel; refs: number; buffer: Array<Payload> | null }
const subs = new Map<string, Sub>() // key: filter string, '' = unfiltered

async function acquire(filter: string): Promise<void> {
  const existing = subs.get(filter)
  if (existing) { existing.refs++; return }
  const channel = supabase.channel(`words:${filter || 'all'}`)
  const sub: Sub = { channel, refs: 1, buffer: [] }
  subs.set(filter, sub)
  channel.on(
    `postgres_changes`,
    { event: `*`, schema: `public`, table: `words`, ...(filter && { filter }) },
    (payload) => ingest(filter, payload),
  )
  await joined(channel) // subscribe(); resolve on SUBSCRIBED, reject on CHANNEL_ERROR/TIMED_OUT
}

function release(filter: string) {
  const sub = subs.get(filter)
  if (!sub || --sub.refs > 0) return
  supabase.removeChannel(sub.channel)
  subs.delete(filter)
}
```

### 3.2 Wiring into the collection

```ts
const filterByQueryHash = new Map<string, string | null>()

const collection = createCollection(queryCollectionOptions({
  queryKey: [`words`],
  syncMode: `on-demand`,
  queryClient,
  getKey: (row) => row.id,
  queryFn: async (ctx) => {
    const opts = (ctx.meta?.loadSubsetOptions ?? {}) as LoadSubsetOptions
    const filter = filterFor(opts.where)              // string | null (§2)
    filterByQueryHash.set(hashKey(ctx.queryKey), filter) // hashKey from @tanstack/query-core
    if (filter !== null) await acquire(filter)        // ① subscribe first
    const rows = await selectFromSupabase(opts)       // ② then fetch
    if (filter !== null) drainBuffer(filter)          // ③ then apply buffered events
    return rows
  },
  ...
}))

queryClient.getQueryCache().subscribe((event) => {
  if (event.type !== `removed`) return
  const filter = filterByQueryHash.get(event.query.queryHash)
  filterByQueryHash.delete(event.query.queryHash)
  if (filter != null) release(filter)
})
```

`selectFromSupabase` translates `opts.where` to PostgREST filters (`.eq()`,
`.gte()`, …) by walking the `BasicExpression` tree — same translation the
fork's siblings do for their backends (electric's `compileSQL`, powersync's
`sqlite-compiler`), just targeting supabase-js. Conveniently, `filterFor` and
`selectFromSupabase` share the clause→PostgREST-operator translation; write it
once. Start with `eq`/`and` plus the comparison ops and throw on anything you
haven't implemented yet.

### 3.3 Buffering across the join/fetch gap

Realtime has no replay. Events can arrive between channel join and the initial
select landing, and rows can change between the select executing and its
response arriving. Ordering ① subscribe → ② fetch → ③ drain, with `ingest`
appending to `buffer` while it's non-null, closes the gap. After drain, set
`buffer = null` so events apply immediately. Applying a buffered event on top
of freshly fetched rows is safe because upsert/delete by primary key is
idempotent.

### 3.4 Ingest

`postgres_changes` payloads are `{ eventType: 'INSERT' | 'UPDATE' | 'DELETE',
new, old }` (`old` contains only replica-identity columns unless you change
that — §4):

```ts
function ingest(filter: string, payload: RealtimePostgresChangesPayload<Word>) {
  const sub = subs.get(filter)
  if (sub?.buffer) { sub.buffer.push(payload); return }
  const { writeUpsert, writeDelete } = collection.utils
  if (payload.eventType === `DELETE`) {
    const key = payload.old?.id
    if (key != null && collection.has(key)) writeDelete(key)
  } else if (matchesResidual(filter, payload.new)) { // client-side residual check (§2)
    writeUpsert(payload.new)
  } else if (collection.has(payload.new.id)) {
    writeDelete(payload.new.id) // updated row no longer matches the narrow predicate
  }
}
```

### 3.5 Reconnects

supabase-js rejoins channels automatically after a drop, but events during the
gap are lost. On re-`SUBSCRIBED` after a disconnect, re-arm the buffer and
refetch the live predicates mapped to that filter —
`collection.utils.refetch()` (or targeted `queryClient.invalidateQueries`)
reconciles the synced store.

---

## 4. Postgres side

No triggers needed — but three settings matter, and one of them is a silent
correctness trap.

### 4.1 Enable the table for realtime

```sql
alter publication supabase_realtime add table public.words;
```

### 4.2 REPLICA IDENTITY FULL — required for filtered DELETEs (the trap)

Filters are evaluated against the **new** record for INSERT/UPDATE and against
the **old** record for DELETE. By default a table's replica identity is its
primary key, so the old record on a DELETE contains *only the PK* — a filter
like `language=eq.hin` can never match it, and **your filtered subscription
silently receives no DELETE events at all**. Rows deleted on the server just
linger in the collection.

```sql
alter table public.words replica identity full;
```

This makes old records carry all columns (so filtered DELETEs arrive, and
UPDATE payloads include full `old`). Cost: extra WAL volume on writes to that
table — fine for most tables, worth knowing on hot ones.

### 4.3 RLS

`postgres_changes` respects RLS per subscriber: each subscriber only receives
rows their role can `select`. For public-facing data that means your `anon`
select policy is doing double duty (REST reads *and* realtime delivery) —
which is exactly what you want, no separate realtime authorization to
maintain. Note the asymmetry: **DELETE events are not RLS-filtered** (there's
no row left to check), so don't put anything sensitive in deletable rows' PKs.

### 4.4 Rows leaving a partition

An UPDATE that moves a row *out* of the partition (`language: 'hin' → 'fra'`)
is filtered against the **new** record, so the `language=eq.hin` subscriber
never hears about it → stale row stays in the collection. Options, in order of
preference:

1. **Partition columns are immutable** in your schema (common — a word's
   language never changes): non-issue, state it and move on.
2. If they can change, add **one extra unfiltered UPDATE-only subscription**
   per table whose handler does nothing unless `collection.has(key)` — a
   departure only matters for rows you already hold, and for held rows the
   handler writes the update or deletes the row if it no longer matches. This
   costs one wide subscription; the filtered ones still carry the arrivals.
3. Accept staleness and rely on refetch-on-remount / periodic `refetch()`.

(The broadcast-from-trigger approach solves this by broadcasting to both the
old and new partition topics; with `postgres_changes` you don't control the
fan-out, hence the workarounds.)

---

## 5. Known gotchas (found while auditing the library internals)

1. **Realtime-written rows are unowned.** On-demand mode tracks which query
   loaded each row and GCs rows when their last owning query unloads. The
   manual write utils do **not** register ownership — verified in
   `manual-sync.ts`. So a row inserted via `writeUpsert` from a realtime event
   survives its partition unloading (a small retention leak, never wrong
   data). Acceptable for the prototype; the library-ification fix is to let
   write utils attribute rows to a predicate/owner. Don't "fix" it by
   `writeDelete`-ing on release — the row may legitimately be owned by another
   live query.
2. **Limits/orderBy don't compose with live inserts.** A predicate with
   `limit` shows the top-N; a realtime insert that belongs in that window will
   appear via `writeUpsert`, but a row that *drops out* of the window won't be
   evicted. Prototype: only subscribe for **unlimited** predicates (mirrors
   the level-3 MVP rule of matching unlimited covers only).
3. **Missed DELETEs without `REPLICA IDENTITY FULL`** — see §4.2. This is the
   one that produces silently-wrong UIs.
4. **Duplicate events** (overlapping filtered + unfiltered subscriptions,
   rejoins) are fine — ingest is idempotent by key — but only if `writeUpsert`
   is used rather than `writeInsert` (which throws on existing keys).
5. **Filter value encoding.** Filter strings are parsed server-side; values
   containing commas/parens (esp. `in.(...)`) need care, and `eq.` on strings
   is unquoted. Keep partition values to simple slugs/ids and this never
   bites.

---

## 6. What graduates into the library later

When this gets extracted (either into the fork's query-db-collection work or a
standalone `supabase-db-collection`):

- **Registry event surface.** The level-3 design's `loadedPredicates` registry
  (design doc §5.2) should expose `onPredicateLoaded/onPredicateUnloaded` —
  then the bridge stops spying on the QueryCache and becomes a plain
  subscriber. Designing that surface in from day one is cheap; this prototype
  is the first consumer and will tell us what the events need to carry.
- **Unified partition config.** `filterFor`'s partition columns and the
  inclusion gate's `dedupeQueriesOn` are the same declaration ("these columns
  are honest partition axes") — one config key, two consumers.
- **Subscription-per-covering-partition.** Once level 3 lands, subset queries
  stop creating observers, so the bridge naturally holds one subscription per
  live partition, with refcount pinning (design doc §5.3) keeping subscription
  lifetime equal to row retention. No bridge changes needed — it falls out of
  the registry semantics.
- **Row ownership for pushed writes** (gotcha #1).
- **Transport swap.** If `postgres_changes` fan-out becomes the bottleneck,
  the bridge's predicate-in/subscription-out shape ports to
  broadcast-from-database — the filter derivation becomes a topic convention +
  trigger. Nothing in the collection-facing half changes.

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
| `compileExpression` (public) | [db/src/query/compiler/evaluators.ts#L89](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/db/src/query/compiler/evaluators.ts#L89) |
| expression→backend-filter precedent | [electric `compileSQL`](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/electric-db-collection/src/electric.ts#L479), [powersync `sqlite-compiler`](https://github.com/mhsnook/tanstack-db/blob/816b667c66c25be5266dbb958a91e2e02e8b53a1/packages/powersync-db-collection/src/sqlite-compiler.ts) |
| level-3 inclusion design | [PREDICATE-INCLUSION-DESIGN.md](https://github.com/mhsnook/tanstack-db/blob/claude/partition-aware-inclusion/packages/query-db-collection/PREDICATE-INCLUSION-DESIGN.md) (branch `claude/partition-aware-inclusion`) |
