---
'@tanstack/query-db-collection': patch
---

Serve load-by-key requests from the collection cache in on-demand mode. When a `get()` or live query filters on the key field (an `eq`/`in` on the key, or an `and` containing one) and every requested key is already present in the collection, the query collection now reuses the cached rows instead of issuing a new request — even when the derived query key doesn't match an existing query. Keys are unique, so an already-cached row is authoritative for that lookup.
