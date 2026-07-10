# Prototyping a Supabase-broadcast bridge on a TanStack DB query collection

**Audience:** the app codebase (a Supabase project) that wants live, public-facing
data on top of a `queryCollectionOptions` collection running in **on-demand** mode
— built in-app first, extracted into a library later.

**Context:** this fork (`mhsnook/tanstack-db`) has been building
predicate-aware loading for query collections:

- **Level 2 (shipped on `claude/partition-aware-inclusion`):** load-by-key
  requests served from already-present rows.
- **Level 3 (design stage):** subset queries served from live *covering*
  queries — see
  [`PREDICATE-INCLUSION-DESIGN.md`](https://github.com/mhsnook/tanstack-db/blob/claude/partition-aware-inclusion/packages/query-db-collection/PREDICATE-INCLUSION-DESIGN.md)
  on that branch.

The idea here: the collection already tracks, per live query, a compiled
predicate (`LoadSubsetOptions.where`). Those same predicates can drive **which
Supabase realtime channels are open at any moment** — one channel per live
partition, opened when the predicate loads, closed when it unloads. Once level 3
lands, narrow subset queries never create their own observers, so the only
predicates that reach the network — and the only channels you need — are the
broad partitions.

**Verdict from investigating the library internals: you can prototype this
entirely in the app, with zero fork/library changes.** The seams below are all
public API today.

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

This is the **subscribe hook**: derive the topic(s) from `opts.where`, join the
channel *before* running the select, and you get subscribe-then-fetch ordering
for free (§3.3).

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
    releaseTopicsFor(event.query.queryHash)
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
to turn a `BasicExpression` into an evaluator, if you want to test an incoming
row against the full `where`. For the prototype you can usually skip it: topics
are derived from partition-column equality, so `record[partitionCol] === value`
is the same check (§3.4).

---

## 2. Topic mapping — the one contract you must define

Supabase **broadcast** has no filter language: a channel topic is an opaque
string, and the server side is a Postgres trigger calling
`realtime.broadcast_changes(topic, ...)`. So the predicate isn't "fed into" a
filter — it's **mapped** to a topic naming convention that your trigger also
follows. That mapping is a contract, exactly like the level-3 design's
`dedupeQueriesOn` is a contract about which columns are honest filters.

For the prototype, declare the partition axes per collection and derive:

```ts
// eq(language, 'hin')  →  'words:language:hin'
topicsFor(where) // → string[] — [] means "no live channel for this predicate"
```

Rules of thumb:

- Only **equality on a declared partition column** maps to a topic. Anything
  else (ranges, ors, compound residuals) returns `[]` — the query still works,
  it just isn't live. Err toward `[]`.
- `and(eq(language,'hin'), eq(difficulty,'hard'))` should map to the *partition*
  topic `words:language:hin` (subscribe wide, filter on ingest). This is the
  same "covering partition" shape level 3 formalizes.
- Keep one canonical topic format: `<table>:<column>:<value>`. The trigger and
  the client must never disagree.

Do **not** use `postgres_changes` for this: one single-column filter per
binding, no compound predicates, per-subscriber RLS evaluation on every change
(scales badly for public traffic). Broadcast-from-database is Supabase's
recommended path and the one this design assumes.

---

## 3. Client architecture

Four small pieces, ~150 lines total in-app.

### 3.1 Refcounted channel manager

Multiple predicates can map to the same topic (e.g. the partition and a
narrow query over it, until level 3 exists):

```ts
const channels = new Map<string, { channel: RealtimeChannel; refs: number; buffer: Array<Payload> | null }>()

async function acquireTopic(topic: string): Promise<void> {
  const entry = channels.get(topic)
  if (entry) { entry.refs++; return }
  const channel = supabase.channel(topic, { config: { private: true } })
  const created = { channel, refs: 1, buffer: [] as Array<Payload> | null }
  channels.set(topic, created)
  channel
    .on(`broadcast`, { event: `INSERT` }, ({ payload }) => ingest(topic, payload))
    .on(`broadcast`, { event: `UPDATE` }, ({ payload }) => ingest(topic, payload))
    .on(`broadcast`, { event: `DELETE` }, ({ payload }) => ingest(topic, payload))
  await joined(channel) // resolve on SUBSCRIBED, reject on CHANNEL_ERROR/TIMED_OUT
}

function releaseTopic(topic: string) {
  const entry = channels.get(topic)
  if (!entry || --entry.refs > 0) return
  supabase.removeChannel(entry.channel)
  channels.delete(topic)
}
```

### 3.2 Wiring into the collection

```ts
const topicsByQueryHash = new Map<string, Array<string>>()

const collection = createCollection(queryCollectionOptions({
  queryKey: [`words`],
  syncMode: `on-demand`,
  queryClient,
  getKey: (row) => row.id,
  queryFn: async (ctx) => {
    const opts = (ctx.meta?.loadSubsetOptions ?? {}) as LoadSubsetOptions
    const topics = topicsFor(opts.where)
    topicsByQueryHash.set(hashKey(ctx.queryKey), topics) // hashKey from @tanstack/query-core
    await Promise.all(topics.map(acquireTopic))   // ① subscribe first
    const rows = await selectFromSupabase(opts)   // ② then fetch
    topics.forEach(drainBuffer)                   // ③ then apply buffered events
    return rows
  },
  ...
}))

queryClient.getQueryCache().subscribe((event) => {
  if (event.type !== `removed`) return
  const topics = topicsByQueryHash.get(event.query.queryHash)
  if (!topics) return
  topicsByQueryHash.delete(event.query.queryHash)
  topics.forEach(releaseTopic)
})
```

`selectFromSupabase` translates `opts.where` to PostgREST filters (`.eq()`,
`.gte()`, …) by walking the `BasicExpression` tree — same translation the
fork's siblings do for their backends (electric's `compileSQL`, powersync's
`sqlite-compiler`), just targeting supabase-js. Start with `eq`/`and` plus the
comparison ops and throw on anything you haven't implemented yet.

### 3.3 Buffering across the join/fetch gap

Broadcast has no replay. Events can arrive between channel join and the initial
select landing; and rows can change between the select executing and the
response arriving. Ordering ① subscribe → ② fetch → ③ drain, with `ingest`
appending to `buffer` while it's non-null, closes the gap. After drain, set
`buffer = null` so events apply immediately. Applying a buffered event on top of
freshly fetched rows is safe because upsert/delete by primary key is idempotent.

### 3.4 Ingest

`realtime.broadcast_changes` payloads carry `{ operation, record, old_record, ... }`
(verify exact shape against your supabase-js version):

```ts
function ingest(topic: string, payload: Payload) {
  const entry = channels.get(topic)
  if (entry?.buffer) { entry.buffer.push(payload); return }
  const { operation, record, old_record } = payload
  const { writeUpsert, writeDelete } = collection.utils
  if (operation === `DELETE`) {
    if (collection.has(getKey(old_record))) writeDelete(getKey(old_record))
  } else if (matchesTopic(topic, record)) {   // partition-column equality check
    writeUpsert(record)
  } else if (collection.has(getKey(record))) {
    writeDelete(getKey(record))               // row moved OUT of this partition
  }
}
```

The `matchesTopic` check matters because you subscribe at partition granularity
but may hold narrower predicates; and because the trigger broadcasts to the
*old* topic when a row leaves a partition (§4), where the row no longer matches
— that's your signal to delete it locally.

### 3.5 Reconnects

On `SUBSCRIBED` after a drop (supabase-js rejoins automatically), you may have
missed events. Re-arm the buffer and refetch every live predicate mapped to
that topic — `collection.utils.refetch()` (or invalidate the specific query
keys via the queryClient) reconciles the synced store.

---

## 4. Postgres side

Trigger contract — broadcast to the row's partition topic, and **also to the
old topic when the partition column changes** (otherwise the old partition's
subscribers never learn the row left):

```sql
create or replace function public.broadcast_words_changes()
returns trigger
security definer
language plpgsql
set search_path = ''
as $$
declare
  new_topic text := 'words:language:' || coalesce(new.language, old.language);
begin
  perform realtime.broadcast_changes(
    new_topic, tg_op, tg_op, tg_table_name, tg_table_schema, new, old
  );
  if tg_op = 'UPDATE' and new.language is distinct from old.language then
    perform realtime.broadcast_changes(
      'words:language:' || old.language,
      tg_op, tg_op, tg_table_name, tg_table_schema, new, old
    );
  end if;
  return null;
end;
$$;

create trigger words_broadcast
  after insert or update or delete on public.words
  for each row execute function public.broadcast_words_changes();
```

Authorization: private channels check RLS on `realtime.messages`. For
public-facing read-only topics:

```sql
create policy "anyone can listen to words partitions"
  on realtime.messages for select
  to authenticated, anon
  using (realtime.topic() like 'words:language:%' and extension = 'broadcast');
```

Never broadcast a topic pattern wider than this policy — the topic namespace
*is* the authorization boundary. If some partitions are non-public, encode that
in the policy, not in the client.

---

## 5. Known gotchas (found while auditing the library internals)

1. **Realtime-written rows are unowned.** On-demand mode tracks which query
   loaded each row and GCs rows when their last owning query unloads. The
   manual write utils do **not** register ownership — verified in
   `manual-sync.ts`. So a row inserted via `writeUpsert` from a broadcast
   event survives its partition unloading (a small retention leak, never wrong
   data). Acceptable for the prototype; the library-ification fix is to let
   write utils attribute rows to a predicate/owner. Don't "fix" it by
   `writeDelete`-ing on release — the row may legitimately be owned by another
   live query.
2. **Limits/orderBy don't compose with live inserts.** A predicate with
   `limit` shows the top-N; a broadcast insert that belongs in that window will
   appear via `writeUpsert` but a row that *drops out* of the window won't be
   evicted. Prototype: only map **unlimited** predicates to topics (mirrors the
   level-3 MVP rule of matching unlimited covers only).
3. **Event payload size.** `realtime.broadcast_changes` ships whole rows; wide
   rows (long text columns) may warrant a slimmer custom payload + client
   refetch-on-notify instead.
4. **Duplicate events** across old+new topic broadcasts or rejoins are fine —
   ingest is idempotent by key — but only if `writeUpsert` is used rather than
   `writeInsert` (which throws on existing keys).

---

## 6. What graduates into the library later

When this gets extracted (either into the fork's query-db-collection work or a
standalone `supabase-db-collection`):

- **Registry event surface.** The level-3 design's `loadedPredicates` registry
  (design doc §5.2) should expose `onPredicateLoaded/onPredicateUnloaded` —
  then the bridge stops spying on the QueryCache and becomes a plain subscriber.
  Designing that surface in from day one is cheap; this prototype is the first
  consumer and will tell us what the events need to carry.
- **Unified partition config.** `topicsFor`'s partition columns and the
  inclusion gate's `dedupeQueriesOn` are the same declaration ("these columns
  are honest partition axes") — one config key, two consumers.
- **Channel-per-covering-partition.** Once level 3 lands, subset queries stop
  creating observers, so the bridge naturally holds one channel per live
  partition with refcount pinning (design doc §5.3) keeping channel lifetime
  equal to row retention. No bridge changes needed — it falls out of the
  registry semantics.
- **Row ownership for pushed writes** (gotcha #1).

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
