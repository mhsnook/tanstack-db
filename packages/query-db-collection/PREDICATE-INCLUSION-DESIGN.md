# Predicate-inclusion loading for query-db-collection

**Status:** design draft. Branch `claude/partition-aware-inclusion`,
built on the load-by-key cache work in PR #1.

**Decision so far:** extend `createQueryFromOpts` in
`packages/query-db-collection/src/query.ts`, reusing the shared predicate
algebra from `@tanstack/db` (`isWhereSubset`, `minusWherePredicates`) but not
adopting `DeduplicatedLoadSubset` as a container (see §6 for why).

---

## 1. The three levels of "don't re-fetch what we already have"

| Level | What it matches on | Substrate | Status |
|-------|--------------------|-----------|--------|
| 1 | Exact same predicate (full params) | hashed query key → observer | shipped (pre-existing) |
| 2 | A lookup **by key** whose keys we already hold | **row presence** (`collection.has`) | shipped ([PR #1](https://github.com/mhsnook/tanstack-db/pull/1)) |
| 3 | A query that is a **subset of an already-loaded query** | **predicate coverage** of live observers | ⭐️ this doc |

Level 2 and level 3 work differently to decide whether the result is already cached;
fetching by Key doesn't require us to compare against any other cached query's predicates,
to ensure completeness, because it's a unique key, so if we have it, we know it's complete.

**Subset lookup (3) has to be able to trust that cached server response are complete and their keys represent
strictly subtractive filters.** Subset lookup logic will fail if there are non-standard behaviors of the server
API. For example: `/api/posts?cat=travel` might filter out archived posts if the developer felt like doing it
that way, in which case, `/api/posts?cat=travel&archived=false` may _look_ like a subset but should not be
treated as one. This is why we need the config in §4, to let the collection-definer tell the collection which
columns act as "proper filters" in the query function.

---

## 2. Scope of this work (and explicit non-goals)

**In scope (MVP):**

- Equality and range inclusion matching (`language='hin'`, or `id BETWEEN 1
  AND 20`) against currently-live loaded queries. The existing algebra already handles both,
  we just want to wire them into the query-db-collection.
- A correctness gate so we only serve locally when it's actually safe (§3, §4).
- Ownership handled via refcount **pinning** so a subset query keeps its covering
  query alive (§5.3).

**Out of scope (deferred):**

- **Proactive widening.** We do *not* automatically rewrite `language='hin' AND
  difficulty='hard'` into a "load the whole language" request. The developer
  draws the outer boundary by loading the broad query themselves (e.g. a route
  loader that preloads all Hindi content and holds it open). Level 3 just
  *matches* new narrow queries against what's already open.
- **Pagination / `limit` tiers.** A limited load only covers same-`where`
  smaller-window queries (`isPredicateSubset`'s limited branch requires
  where-equality), so it does not compose with arbitrary added filters. MVP
  matches against **unlimited** loaded queries only; anything with a `limit` is
  skipped conservatively. The related question of *how* limited loads are
  chunked/prefetched from the server is a separate, lower-layer concern — see §7.
- **Sibling/cousin unions** (served from the union of two partitions).
  `unionWherePredicates` gives some of this for free later; not now.
- **Re-validation beyond remount.** If the covering query is torn down while a
  subset is still mounted, see §5.3 — pinning prevents the rows from vanishing
  in the common case; deeper re-validation is future work.

---

## 3. Correctness model

We send the server a predicate **L**, receive rows **R(L)**. To serve a narrower
query **N ⊆ L** locally we display `{ r ∈ R(L) : N(r) }`. This equals the true
answer **only if R(L) contains every row that genuinely matches N.**

On the client, narrowing is provably faithful (we control the query engine). The
**server is opaque** and may apply hidden predicates (auth, soft-delete, default
scopes). So `isWhereSubset(N, L)` is **necessary but not sufficient.**

### The failure case (why this is a correctness feature, not just loading)

- `L = language='hin'` → server hides archived rows by default → `R(L)` has none.
- `N = language='hin' AND archived=true`. Pure algebra: `N ⊆ L` ✅.
- Serve locally → `{ r ∈ R(L) : archived }` = **∅**, but the true answer is
  non-empty. **Silent undercount / missing category.**

The dangerous column is one where **narrowing the query can *add* rows the
broader query omitted** — i.e. the server is non-monotonic on that column. Such a
column is unsafe to apply as a *local residual* filter.

### The rule

Serve `N` from `L` iff:

1. `isWhereSubset(N, L)` (and, for MVP, `L` is unlimited), **and**
2. the **residual** `minusWherePredicates(N, L)` (the part applied locally rather
   than on the server) references **only inclusion-safe columns** (§4).

Notes:

- **Only the residual matters.** A hidden filter on a column that neither query
  mentions applies uniformly to both `R(L)` and the true `R(N)`, so subsetting
  stays correct. A hidden filter on a column that `L` constrains but `N` doesn't
  narrow further is also fine. Only columns where `N` is *stricter than L* are
  being trusted.
- **The gate errs toward fetching.** If the residual can't be simplified
  (`minusWherePredicates` returns `null`) or touches any non-safe column, we fall
  through to a normal fetch. Worst case is a redundant request, never wrong data.
- **Level 2 needs no gate.** It serves from physically-present rows and bounds to
  a unique key, so it's correct even for `id=5 AND archived=true` (we apply the
  filter to the real row we hold). The gate applies to level 3 only.

---

## 4. Configuration — candidate shapes

The config answers one question: **which columns are "inclusion-safe"** (the
server applies no hidden, non-monotonic filtering on them, so they're safe to
apply as a local residual)?

Below are several shapes considered, with trade-offs. They are not mutually
exclusive — the recommendation (§4.6) is a single option key that accepts several
forms.

Working name: `dedupeQueriesOn` (alternatives: `inclusionSafeColumns`,
`strictFilterColumns`, `clientFilterableColumns`). Naming is unresolved — see
§4.7.

### 4.1 Off by default — the non-negotiable

**No config ⇒ level 3 does nothing.** Levels 1 and 2 still apply (level 2 is
unconditionally safe). This is the only default that is neither a footgun nor a
breaking change: existing collections keep their exact current behavior on
upgrade. Every shape below is an explicit opt-in.

### 4.2 Whole-collection boolean

```ts
queryCollectionOptions({ ..., dedupeQueriesOn: true })
```

"Every column on this table is a faithful, monotonic filter — trust all
narrowing." The residual gate becomes a no-op; matching is pure `isWhereSubset`.

- **Good for:** simple backends that translate `where` straight to SQL with no
  hidden scopes.
- **Risk:** most real backends hide *something* (soft-delete, tenancy, auth), so
  blanket `true` is rarely fully correct. Easy to reach for, easy to get wrong.

### 4.3 Allowlist of safe columns

```ts
queryCollectionOptions({ ..., dedupeQueriesOn: ['language', 'added_by', 'difficulty'] })
```

Only these columns may appear in a residual. Anything else ⇒ fetch.

- **Good for:** the common case. Safe-by-default *within* the opt-in: forgetting
  a column means an unnecessary fetch, never wrong data.
- **Cost:** the developer must enumerate the safe axes. That's the right amount
  of friction for a correctness contract.
- **Recommended primary form.**

### 4.4 Denylist of unsafe columns (explicit opt-in only)

```ts
queryCollectionOptions({ ..., dedupeQueriesOn: { except: ['archived'] } })
```

"Trust everything *except* these special-cased columns." Mentally clean — it
mirrors the server: *"I special-cased `archived` on the server, so I special-case
it on the client."*

- **The denylist footgun is real, and avoided by construction:** a denylist is
  only dangerous if it implies *dedupe-everything-by-default*. Here it does not —
  you still had to **set `dedupeQueriesOn` at all** to turn the feature on. The
  `{ except: [...] }` form is just an ergonomic shape of an *explicit* opt-in, not
  a default behavior. Absence still means off (§4.1), so there is no
  silent-on-upgrade breaking change and no aggressive deduping in the absence of
  the setting.
- **Residual risk:** forgetting to denylist a genuinely-unsafe column ⇒ silent
  incomplete data. This is strictly more dangerous than the allowlist's
  failure mode (extra fetch). So: offer it, but document the asymmetry and steer
  people to the allowlist unless their backend really is faithful-except-for-a-few.

### 4.5 Escape hatch: predicate function

```ts
queryCollectionOptions({
  ...,
  dedupeQueriesOn: (residual: LoadSubsetOptions) => boolean,
})
```

For backends whose safety isn't expressible as a flat column set (e.g. "`status`
is safe except the value `archived`", or column-combination rules). Powerful,
but punts correctness entirely to the developer; offer only as a last resort.

### 4.6 Recommended: one key, several forms

```ts
type DedupeQueriesOn =
  | false                       // default — level 3 off
  | true                        // all columns inclusion-safe
  | Array<string>               // allowlist of safe columns
  | { except: Array<string> }   // denylist (still an explicit opt-in)
  | ((residual: LoadSubsetOptions) => boolean) // escape hatch

queryCollectionOptions({ ..., dedupeQueriesOn })
```

This covers the faithful-backend (`true`), the precise-axes (`string[]`), the
mostly-faithful (`{ except }`), and the irregular (`fn`) cases with one
opt-in-only surface and a safe default.

### 4.7 Open questions on config

- **Naming.** `dedupeQueriesOn: ['language']` can be misread as "dedupe queries
  *keyed* on language." The semantics are "columns safe to apply as a local
  residual filter." `clientFilterableColumns` / `strictFilterColumns` read more
  precisely; `dedupeQueriesOn` reads better at the call site. Undecided.
- **eq vs range.** No separate config needed: `isWhereSubset` /
  `minusWherePredicates` already handle both equality and range residuals, so a
  column listed as safe is safe for both forms. (A backend could conceivably be
  faithful on equality but not range — rare; the `fn` escape hatch covers it.)
- **Per-query override.** Should a single live query be able to opt out
  (`{ dedupe: false }`) even when the collection opts in? Probably yes,
  eventually; not MVP.
- **Schema annotations.** If a Standard Schema is present, safe columns could be
  annotated there instead of duplicated in config. Tempting but magic; defer.

---

## 5. Architecture (Plan A)

### 5.1 Where it hooks in

`createQueryFromOpts(opts)` in `query.ts` is the registered `loadSubset` handler
(`loadSubset: loadSubsetDedupe`). The new step sits immediately **after** the
level-2 key short-circuit and **before** the observer-creation path:

```
createQueryFromOpts(opts):
  startup-retention gate (existing)
  level-2 key short-circuit (existing)            ← row presence
  level-3 inclusion match (NEW)                    ← predicate coverage, gated
  generate query key / observer-reuse (existing)
  create observer + fetch (existing)
```

### 5.2 Matching (the cheap part)

Maintain a registry of **live** loaded predicates:

```
loadedPredicates: Map<hashedQueryKey, LoadSubsetOptions>
```

- **Add** when an observer is created (where the observer + `hashToQueryKey` are
  populated today).
- **Remove** in `cleanupQueryInternal` (where the observer is torn down today).

Tying the registry to live observers — rather than a monotonic coverage log — is
what keeps coverage honest: when the covering query's observer is cleaned up and
its rows are GC'd, its entry leaves the registry, so later subset queries
correctly miss and fetch. (This is the crux of §6.)

On a new `opts` with a `where`, after level 2:

```
for (const L of loadedPredicates.values()):
  if L.limit !== undefined: continue                 // MVP: unlimited only
  if not isWhereSubset(opts.where, L.where): continue
  residual = minusWherePredicates(opts.where, L.where)
  if residual === null: continue                     // can't prove → fetch
  if not residualColumnsAllSafe(residual, config): continue
  → served by L (see 5.3); return true
// no cover → fall through to normal observer creation + fetch
```

`residualColumnsAllSafe` walks the residual expression collecting referenced
`ref` paths and checks them against the configured safe set (or `true`/`fn`).

### 5.3 Ownership via refcount pinning (the part that's usually hard)

When `N` is served by `L`:

1. Increment **L's** existing `queryRefCounts[hashKey(L)]`.
2. Record `servedBy.set(hashKey(N), hashKey(L))`.
3. Return `true` (no observer, no QueryClient entry — same as level 2).

On `unloadSubset(N)`:

- If `servedBy` has `hashKey(N)`: decrement **L's** refcount via the existing
  `cleanupQueryIfIdle(hashKey(L))` path; delete the `servedBy` entry.
- Else: existing behavior.

Effect: a route loader holds `L=language='hin'` (refcount 1). A subset query `N`
arrives → pins L (refcount 2). Route loader tears down → refcount 1, **rows
stay** because N still depends on L. N tears down → refcount 0 → L cleans up,
rows GC. This reuses the existing refcount machinery and gives correct lifetime
without proactive widening or grandparent/cousin bookkeeping.

**Known limitation (accepted):** if the developer tears down the covering query
while a subset is still mounted *and* nothing else pins it, the subset goes
incomplete. The route-loader pattern (hold the broad query for the boundary's
lifetime) is the intended usage; pinning makes the common case correct.

### 5.4 Detail: covering query still loading

If the matched `L`'s observer hasn't resolved yet, mirror the existing
"observer exists but loading" branch in `createQueryFromOpts` — subscribe and
return a promise that resolves on L's first success — so N resolves when L's data
lands. Alternatively (simpler MVP) only match against observers whose result is
already `isSuccess`, letting still-loading cases fetch their own. Start simple.

### 5.5 Picking among multiple covers

If several live L cover N, prefer the **most specific** (smallest covering set) to
minimize over-retention, or just the first for MVP. Refinement, not correctness.

---

## 6. Why not `DeduplicatedLoadSubset` (divergence from Electric)

Electric wraps its concrete fetch in `new DeduplicatedLoadSubset({ loadSubset })`
and we want to stay aligned with the maintainers' direction — so this is a
deliberate, reasoned divergence, not a casual one.

`DeduplicatedLoadSubset` tracks **monotonic** coverage: `unlimitedWhere` only
grows (unioned), and the only way to forget anything is `reset()` (all-or-nothing,
on truncate). That's correct for Electric because a live shape **keeps the data
resident** — coverage and reality stay in sync.

**query-db-collection GCs rows when a query unloads.** Wrapping it in
`DeduplicatedLoadSubset` would mean:

- route loader loads `language='hin'` → coverage records it,
- route loader tears down → query-db GCs the Hindi rows,
- coverage **still says** `language='hin'` is covered → next subset query returns
  `true` → **serves from rows that no longer exist** → silent incomplete data —
  the precise failure this whole feature exists to prevent.

So we reuse the **algebra** (`isWhereSubset`, `minusWherePredicates` — shared,
exported, tested) but **not the container**. The registry tied to live observers
(§5.2) is the lifecycle-correct analogue of `DeduplicatedLoadSubset` for a
GC-on-unload collection.

If the maintainers later want one shared mechanism, the right core change is to
teach `DeduplicatedLoadSubset` (a) lifecycle-aware / non-monotonic coverage and
(b) an injectable `canServeFromSuperset(req, loaded)` gate (defaulting to
`isWhereSubset`, so Electric is unaffected) for the inclusion-safe check. That's a
larger, separate conversation — not a prerequisite for shipping this.

---

## 7. Forward-looking: server-query batching (separate concern, flagged here)

This is **not** part of the predicate-inclusion MVP and lives at a **different
layer** (db-core, not query-db-collection). It's recorded here because the two
features are the same family of idea — *"fetch differently from what the client
literally asked for, to amortize round-trips"* — and decisions here should leave
a clean entry-point rather than hard-code today's behavior.

### 7.1 Current behavior (measured, not assumed)

The lazy-load path for `orderBy + limit` queries **with an index** lives in
db-core: `CollectionSubscriber.loadMoreIfNeeded` → `dataNeeded()` →
`loadNextItems(n)` → `subscription.requestLimitedSnapshot(...)`.

- `dataNeeded() = Math.max(0, limit - currentSize)` — it asks for **exactly the
  deficit**, no overscan, no chunk rounding.
- A single-flight guard (`pendingOrderedLoadPromise`) prevents overlapping ordered
  loads; the window can slide (`setWindowFn` updates offset/limit).
- **There is no prefetch-ahead and no chunk-size concept.** The server fetch is
  tightly coupled to what the client window needs at that moment.
- Without an index (or with auto-indexing off), there's no lazy loading at all —
  data is loaded eagerly via `requestSnapshot`.

So the client↔server relationship is *managed* (demand-driven, single-flight,
sliding window) but **exact-fit**, not *buffered*. The decoupling described below
does not exist yet.

### 7.2 The principle: decouple client window from server chunk

The client's window (what the live query shows / how far it has advanced) and the
server fetch granularity (how many rows we pull per round-trip) should be
**independent**. Today `n = deficit` couples them. A batching policy would let us:

- round `n` up to a server-friendly **chunk size**,
- **prefetch ahead** (keep a buffer beyond the visible window so the client can
  advance several steps with no round-trip — e.g. advance 3×, then fetch the next
  3),
- **adapt** the chunk size from observed results (fetch one batch, measure
  avg rows/request or row size, size subsequent batches accordingly).

### 7.3 A flexible entry-point (sketch, db-core)

The single decision point is "given the current deficit and what we know, how many
rows should we actually request?" Today that's hard-coded as the deficit. Replace
it with an injectable policy, defaulting to current behavior:

```ts
// db-core, consulted inside loadNextItems / dataNeeded
type BatchPolicy = (ctx: {
  needed: number          // current deficit (today's n)
  loadedSoFar: number     // rows already materialized for this subscription
  windowSize: number      // current limit (+offset)
  avgRowsPerRequest?: number // observed, for adaptation
  requestCount: number    // how many fetches issued so far
}) => number              // rows to request this round (>= needed)
```

- **Default:** `({ needed }) => needed` — exactly today's behavior, zero change.
- **Fixed chunk:** `({ needed }) => Math.ceil(needed / 200) * 200`.
- **Prefetch/overscan:** `({ needed, windowSize }) => needed + windowSize` (keep
  ~one window buffered ahead), paired with a **low-water-mark trigger** so
  `loadMoreIfNeeded` fires when remaining buffer < threshold rather than only when
  `deficit > 0`.
- **Adaptive:** use `avgRowsPerRequest` / `requestCount` to grow chunk size.

Surfaced as a collection option (e.g. `loadBatchSize?: number | BatchPolicy`),
read by db-core's lazy-load layer. Because it lives in db-core, **all** adapters
(query, electric, trailbase) benefit; query-db-collection's `createQueryFromOpts`
just receives whatever `limit` db-core decides — no query-db changes needed for
the fetch side.

### 7.4 Why mention it in a *predicate* doc — the real intersections

1. **Widening is batching's coarsest cousin.** The deferred "load the whole
   `language='hin'` partition instead of the narrow query" (§2) is the same move
   as "fetch a bigger chunk than asked because it amortizes." A future unified
   `loadStrategy(requestedOpts) → opts-to-actually-send` hook could express both
   widening *and* chunking in one place — worth keeping in mind so we don't build
   two overlapping mechanisms.
2. **Chunked partition loads break the clean inclusion property — until they
   finish.** §2/§3 lean on a partition being loaded as an **unlimited** query (so
   any added filter is a subset). If a partition is instead fetched in *chunks*
   (limited/cursor loads), mid-load it only covers same-`where` smaller windows —
   the hard pagination tier. But once *all* chunks land, it's effectively
   unlimited again and composes. So a batched partition needs a
   **"fully-loaded yet?"** bit that the inclusion gate (§5.2) consults: serve
   subsets locally only once the partition's last chunk has arrived. This is the
   one place the two features genuinely couple, and the entry-point in §7.3 should
   make that completion state observable.

### 7.5 Recommendation

Keep batching **out of the inclusion MVP**, but: (a) when implementing §5, don't
assume `limit === undefined` is the only "complete partition" signal — leave room
for a "complete" flag so a future fully-loaded chunked partition can also be a
match source; (b) treat §7.3's `BatchPolicy` as the intended db-core seam and
avoid hard-coding `n = deficit` assumptions elsewhere. Actual batching is its own
project with its own design pass.

## 8. Test plan

- `eq` partition: load `language='hin'`; `language='hin' AND difficulty='hard'`
  served locally, no fetch; correct rows.
- range partition: load `id BETWEEN 1 AND 20`; `id BETWEEN 5 AND 10` and
  `id BETWEEN 5 AND 10 AND difficulty='hard'` served locally.
- **correctness gate:** `archived` not in safe set ⇒ `language='hin' AND
  archived=true` **does** fetch (does not serve a wrong empty result).
- gate config forms: `true`, allowlist, `{ except }`, `fn` each behave.
- **default off:** no config ⇒ subset queries fetch (no behavior change).
- ownership: route loader + subset; tear down route loader → rows remain while
  subset mounted; tear down subset → rows GC.
- conservative fallbacks: unsimplifiable residual ⇒ fetch; limited `L` ⇒ skipped.
- `or`-nested key/partition ⇒ not served (carried over from PR #1).

---

## References — code pointers

Links pin to commit [`883bbc3`](https://github.com/mhsnook/tanstack-db/tree/883bbc31aec5ade6cad82d75cd9f18381f832017)
so line numbers stay stable. Everything under `packages/query-db-collection` is
our code (incl. the PR #1 work this builds on); everything under `packages/db`
and `packages/electric-db-collection` is the surrounding TanStack DB core /
sibling adapter.

### Levels 1 & 2 — shipped today (§1, §2)

- [`createQueryFromOpts`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/query-db-collection/src/query.ts#L1192) — the registered on-demand `loadSubset` handler; holds level-1 exact-key observer reuse and is where the level-3 hook lands.
- [level-2 load-by-key short-circuit](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/query-db-collection/src/query.ts#L1203) — returns `true` (no fetch) when every requested key is already in the collection.
- [`getKeyFieldPath`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/query-db-collection/src/query.ts#L664) / [`extractKeyLookupValues`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/query-db-collection/src/query.ts#L712) — derive the key field (via proxy) and pull key values from a where-clause; §5 generalizes this ref-matching to arbitrary safe columns.

### Predicate algebra — reused as-is (§3, §4.7, §5.2)

- [`isWhereSubset`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/db/src/query/predicate-utils.ts#L21) — is `N ⊆ L`? The necessary-but-not-sufficient condition in §3's rule.
- [`minusWherePredicates`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/db/src/query/predicate-utils.ts#L340) — computes the residual (`N` minus `L`) whose columns the correctness gate checks.
- [`isPredicateSubset`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/db/src/query/predicate-utils.ts#L856) — where + orderBy + limit subset check; its limited-superset branch (requires where-equality) is exactly why §2 defers pagination.
- [`unionWherePredicates`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/db/src/query/predicate-utils.ts#L297) — the sibling/cousin union deferred in §2.

### Config surface — proposed (§4)

- [`QueryCollectionConfig`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/query-db-collection/src/query.ts#L61) — the options interface where `dedupeQueriesOn` would be added (not yet implemented).

### Ownership / lifetime — to extend (§5.3)

- [`queryRefCounts`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/query-db-collection/src/query.ts#L799) — the per-query refcount map §5.3 pins the covering query in.
- [`unloadSubset`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/query-db-collection/src/query.ts#L1826) — the decrement path; extended to decrement the covering `L` via a `servedBy` map.
- [`cleanupQueryIfIdle`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/query-db-collection/src/query.ts#L1681) / [`cleanupQueryInternal`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/query-db-collection/src/query.ts#L1615) — GC an idle query and its owned rows; the live-predicate registry (§5.2) is removed here.
- [`loadSubset` / `unloadSubset` registration](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/query-db-collection/src/query.ts#L1848) — where the on-demand handlers are wired onto the sync result.

### Why not `DeduplicatedLoadSubset` (§6)

- [`DeduplicatedLoadSubset`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/db/src/query/subset-dedupe.ts#L34) — the shared coverage container we deliberately do **not** adopt.
- [`unlimitedWhere`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/db/src/query/subset-dedupe.ts#L46) + [`reset`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/db/src/query/subset-dedupe.ts#L194) — the monotonic coverage state (only grows; all-or-nothing reset) that would go stale under query-db's GC-on-unload.
- [`onDeduplicate`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/db/src/query/subset-dedupe.ts#L41) — the per-dedup hook a future shared integration would wire to row tracking.
- [electric's usage](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/electric-db-collection/src/electric.ts#L539) — `new DeduplicatedLoadSubset({ loadSubset })`, the pattern §6 diverges from.

### Batching — forward-looking (§7)

- [`loadMoreIfNeeded`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/db/src/query/live/collection-subscriber.ts#L322) → [`loadNextItems`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/db/src/query/live/collection-subscriber.ts#L384) — the demand-driven lazy-load loop; the `n` decision point a `BatchPolicy` would replace.
- [`dataNeeded`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/db/src/query/compiler/order-by.ts#L315) — computes `limit - size`, i.e. today's exact-deficit (no overscan / chunking).
- [`requestLimitedSnapshot`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/db/src/collection/subscription.ts#L430) / [`requestSnapshot`](https://github.com/mhsnook/tanstack-db/blob/883bbc31aec5ade6cad82d75cd9f18381f832017/packages/db/src/collection/subscription.ts#L342) — the sync-layer snapshot calls that the requested size flows into.
