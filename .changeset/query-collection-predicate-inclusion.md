---
'@tanstack/query-db-collection': minor
---

Add opt-in predicate-inclusion deduplication for on-demand query collections via a new `dedupeQueriesOn` option. When set, a narrower query (e.g. `language='hin' AND difficulty='hard'`) is served locally from a live, already-loaded broader query (e.g. `language='hin'`) instead of issuing a new request, provided the narrowing touches only columns declared inclusion-safe. Accepted forms: `true` (trust all columns), an allowlist array of safe columns (recommended), `{ except: [...] }` (trust all but these), or a predicate function receiving the residual. A served subset pins its covering query's refcount, so the covering rows survive the broad query's teardown while the subset is mounted. Off by default — absent config means no behavior change.
