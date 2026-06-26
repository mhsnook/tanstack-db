import { deepEquals } from '@tanstack/db'
import {
  GetKeyRequiredError,
  QueryClientRequiredError,
  QueryKeyRequiredError,
} from './errors'
import { createWriteUtils } from './manual-sync'
import type { SyncContext } from './manual-sync'
import type {
  BaseCollectionConfig,
  ChangeMessage,
  CollectionConfig,
  SyncConfig,
  UtilsRecord,
} from '@tanstack/db'
import type { Query, QueryClient, QueryKey } from '@tanstack/query-core'
import type { StandardSchemaV1 } from '@standard-schema/spec'

/**
 * Sentinel used inside a `queryKey` pattern to match any single segment.
 *
 * `['user_card', '*']` matches `['user_card', 'mine']`,
 * `['user_card', 'lang', 'hin']`, `['user_card', { status: 'skipped' }]`, etc.
 * Matching is prefix-based: a key may be longer than the pattern.
 */
export const WILDCARD = `*`

/**
 * Configuration for a Query Union Collection.
 *
 * Unlike {@link queryCollectionOptions}, which binds a collection to a single
 * `queryKey`/`queryFn`, a union collection is defined by a *pattern* of query
 * keys. Any query already in (or later added to) the TanStack Query cache whose
 * key matches the pattern is folded into a single, primary-key-deduplicated
 * collection. Live queries read the union; React Query owns fetching,
 * staleness, dedup, retry and garbage collection.
 *
 * This means you fetch in route loaders (`queryClient.ensureQueryData(...)`),
 * query freely in components (no per-component fetch), and let different queries
 * carry different cache times — short for foreground data, long for background.
 *
 * @template T - The type of items stored in the collection
 * @template TError - The type of errors that can occur during queries
 * @template TKey - The type of the item keys
 * @template TSchema - The schema type for validation
 */
export interface QueryUnionCollectionConfig<
  T extends object = Record<string, unknown>,
  TError = unknown,
  TKey extends string | number = string | number,
  TSchema extends StandardSchemaV1 = never,
> extends BaseCollectionConfig<T, TKey, TSchema> {
  /** The TanStack Query client whose cache feeds this collection. */
  queryClient: QueryClient

  /**
   * The query key pattern that defines this collection's membership.
   *
   * Matching is prefix-based and segment-by-segment. Use {@link WILDCARD}
   * (`'*'`) to match any single segment. A key matches when every pattern
   * segment matches (deeply) and the key is at least as long as the pattern.
   *
   * @example ['user_card', '*'] // any key beginning with 'user_card' (length >= 2)
   * @example ['user_card']      // any key beginning with 'user_card'
   */
  queryKey: QueryKey

  /**
   * Optional custom matcher. When provided it fully replaces the default
   * `queryKey` pattern matching (the `queryKey` is then used only to derive
   * the prefix for {@link QueryUnionCollectionUtils.invalidate}).
   */
  match?: (queryKey: QueryKey) => boolean

  /**
   * Extract the array of rows from a single matching query's data.
   *
   * Defaults to: arrays are used as-is, and a single non-array object is
   * wrapped into a one-element array. This lets list queries (returning
   * `Array<T>`) and single-item queries (returning `T`) feed the same union
   * with no extra configuration. Provide `select` for wrapped responses such
   * as `{ data, meta }`.
   */
  select?: (data: TError extends never ? never : unknown) => Array<T>

  /**
   * Build the query key used to fetch a single item by its collection key.
   * Required to enable {@link QueryUnionCollectionUtils.ensureItem}. If the
   * returned key matches the collection's pattern, the fetched item flows into
   * the union automatically via the cache subscription.
   */
  itemQueryKey?: (key: TKey) => QueryKey

  /**
   * Fetch a single item by its collection key. Required to enable
   * {@link QueryUnionCollectionUtils.ensureItem}.
   */
  itemQueryFn?: (key: TKey) => Promise<T> | T

  /**
   * staleTime applied to single-item fetches issued by `ensureItem`. Lets
   * point lookups refresh on a different cadence than list queries.
   */
  itemStaleTime?: number
}

/**
 * Utility methods exposed on a Query Union Collection.
 */
export interface QueryUnionCollectionUtils<
  T extends object = Record<string, unknown>,
  TKey extends string | number = string | number,
> extends UtilsRecord {
  /**
   * Invalidate matching queries so React Query refetches them. With no
   * argument, invalidates everything under the pattern's static prefix (the
   * segments before the first wildcard). Pass a narrower key to scope it.
   */
  invalidate: (queryKey?: QueryKey) => Promise<void>

  /**
   * Ensure a single item is available, reusing union data when possible.
   *
   * If the item is already present in the union (loaded by *any* matching
   * query) this resolves immediately with no network request — this is the
   * sound, primary-key form of "do I already have this?". Otherwise it issues a
   * single-item fetch via `itemQueryKey`/`itemQueryFn`.
   *
   * @throws if `itemQueryKey`/`itemQueryFn` were not configured.
   */
  ensureItem: (key: TKey) => Promise<T | undefined>

  /** Whether the given key is currently present in the union. */
  has: (key: TKey) => boolean

  /** The query keys currently feeding the union. */
  activeQueryKeys: () => Array<QueryKey>

  /** Insert one or more items directly into the union's synced store (local only). */
  writeInsert: (data: T | Array<T>) => void
  /** Update one or more items directly in the union's synced store (local only). */
  writeUpdate: (updates: Partial<T> | Array<Partial<T>>) => void
  /** Delete one or more items directly from the union's synced store (local only). */
  writeDelete: (keys: TKey | Array<TKey>) => void
  /** Insert-or-update one or more items directly in the union's synced store (local only). */
  writeUpsert: (data: Partial<T> | Array<Partial<T>>) => void
  /** Run multiple direct writes as a single atomic batch. */
  writeBatch: (callback: () => void) => void
}

/**
 * Returns true if `key` matches `pattern` using prefix + per-segment wildcard
 * semantics. `WILDCARD` matches any single segment; remaining key segments
 * beyond the pattern length are ignored (prefix match).
 */
export function keyMatchesPattern(key: QueryKey, pattern: QueryKey): boolean {
  if (key.length < pattern.length) return false
  for (let i = 0; i < pattern.length; i++) {
    const segment = pattern[i]
    if (segment === WILDCARD) continue
    if (!deepEquals(segment, key[i])) return false
  }
  return true
}

/** The static prefix of a pattern: the segments before the first wildcard. */
function prefixOf(pattern: QueryKey): QueryKey {
  const idx = pattern.findIndex((segment) => segment === WILDCARD)
  return idx === -1 ? pattern : pattern.slice(0, idx)
}

/**
 * Creates collection options for a collection whose contents are the union of
 * every TanStack Query cache entry matching a query-key pattern.
 *
 * @example
 * const cards = createCollection(
 *   queryUnionCollectionOptions({
 *     queryClient,
 *     queryKey: ['user_card', '*'],
 *     getKey: (card) => card.id,
 *   }),
 * )
 *
 * // Anywhere — a route loader, a component, a background prefetch:
 * queryClient.ensureQueryData({ queryKey: ['user_card', 'mine'], queryFn: fetchMine })
 * queryClient.ensureQueryData({ queryKey: ['user_card', 'lang', 'hin'], queryFn: fetchHin })
 * // ...both sets of rows are now queryable from `cards` via live queries.
 */
export function queryUnionCollectionOptions<
  T extends object = Record<string, unknown>,
  TError = unknown,
  TKey extends string | number = string | number,
  TSchema extends StandardSchemaV1 = never,
>(
  config: QueryUnionCollectionConfig<T, TError, TKey, TSchema>,
): CollectionConfig<T, TKey, TSchema> & {
  schema?: TSchema
  utils: QueryUnionCollectionUtils<T, TKey>
} {
  const {
    queryClient,
    queryKey: pattern,
    match,
    select,
    itemQueryKey,
    itemQueryFn,
    itemStaleTime,
    getKey,
    ...baseCollectionConfig
  } = config

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!pattern) throw new QueryKeyRequiredError()
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!queryClient) throw new QueryClientRequiredError()
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!getKey) throw new GetKeyRequiredError()

  const matches = match ?? ((key: QueryKey) => keyMatchesPattern(key, pattern))
  const invalidationPrefix = prefixOf(pattern)

  // Default extraction: arrays pass through; a lone object becomes [object].
  // This is what lets single-item queries and list queries share one union.
  const extract = (data: unknown): Array<T> => {
    const result = select
      ? select(data as never)
      : Array.isArray(data)
        ? (data as Array<T>)
        : [data as T]
    return result
  }

  // Reference to the live sync write context, captured when sync starts.
  let writeContext: SyncContext<any> | null = null

  const internalSync: SyncConfig<any, TKey>[`sync`] = (params) => {
    const { begin, write, commit, markReady, collection } = params

    const cache = queryClient.getQueryCache()

    // rowKey -> set of query hashes that currently include this row.
    // A row survives in the union as long as at least one query owns it.
    const rowOwners = new Map<TKey, Set<string>>()
    // queryHash -> the set of row keys that query last contributed.
    const queryRows = new Map<string, Set<TKey>>()

    // Capture the write context for manual write utils.
    writeContext = {
      collection: collection as any,
      queryClient,
      queryKey: invalidationPrefix as Array<unknown>,
      getKey: getKey as (item: any) => string | number,
      begin,
      write: write as (message: Omit<ChangeMessage<any>, `key`>) => void,
      commit,
      // Direct writes stay local to the union; they must not clobber any
      // individual query's cache entry under the (prefix-only) key.
      updateCacheData: () => {},
    }

    /** Fold a single matching query's current data into the union. */
    const ingest = (query: Query) => {
      const data = query.state.data
      if (query.state.status !== `success` || data === undefined) return

      const items = extract(data)
      // Defensive runtime validation (the declared type claims objects, but the
      // query cache can hold anything).
      const looksValid =
        Array.isArray(items) &&
        (items as Array<unknown>).every(
          (item) => typeof item === `object` && item !== null,
        )
      if (!looksValid) {
        console.error(
          `[QueryUnionCollection] Expected an array of objects for queryKey ` +
            `${JSON.stringify(query.queryKey)}; got ${typeof items}. ` +
            `Provide a \`select\` to extract rows.`,
        )
        return
      }

      const hash = query.queryHash
      const prevRows = queryRows.get(hash) ?? new Set<TKey>()
      const nextItems = new Map<TKey, T>()
      for (const item of items) nextItems.set(getKey(item), item)

      const inserts: Array<T> = []
      const updates: Array<T> = []
      const deletes: Array<T> = []

      // Rows this query used to contribute but no longer does.
      for (const key of prevRows) {
        if (nextItems.has(key)) continue
        const owners = rowOwners.get(key)
        owners?.delete(hash)
        if (!owners || owners.size === 0) {
          rowOwners.delete(key)
          const existing = collection._state.syncedData.get(key)
          if (existing) deletes.push(existing as T)
        }
      }

      // Rows this query contributes now.
      for (const [key, item] of nextItems) {
        let owners = rowOwners.get(key)
        if (!owners) {
          owners = new Set()
          rowOwners.set(key, owners)
        }
        owners.add(hash)
        const existing = collection._state.syncedData.get(key)
        if (!existing) {
          inserts.push(item)
        } else if (!deepEquals(existing, item)) {
          updates.push(item)
        }
      }

      queryRows.set(hash, new Set(nextItems.keys()))

      if (inserts.length || updates.length || deletes.length) {
        begin()
        for (const value of inserts) write({ type: `insert`, value })
        for (const value of updates) write({ type: `update`, value })
        for (const value of deletes) write({ type: `delete`, value })
        commit()
      }

      markReady()
    }

    /** A query left the cache (gc); release its ownership of rows. */
    const dropQuery = (hash: string) => {
      const prevRows = queryRows.get(hash)
      if (!prevRows) return

      const deletes: Array<T> = []
      for (const key of prevRows) {
        const owners = rowOwners.get(key)
        owners?.delete(hash)
        if (!owners || owners.size === 0) {
          rowOwners.delete(key)
          const existing = collection._state.syncedData.get(key)
          if (existing) deletes.push(existing as T)
        }
      }
      queryRows.delete(hash)

      if (deletes.length) {
        begin()
        for (const value of deletes) write({ type: `delete`, value })
        commit()
      }
    }

    // Seed from queries already present in the cache.
    for (const query of cache.getAll()) {
      if (matches(query.queryKey)) ingest(query)
    }
    // Ready even if nothing matched yet — data flows in as queries arrive.
    markReady()

    const unsubscribe = cache.subscribe((event) => {
      const { query } = event
      if (!matches(query.queryKey)) return

      switch (event.type) {
        case `added`:
        case `updated`:
          ingest(query)
          break
        case `removed`:
          dropQuery(query.queryHash)
          break
        default:
          break
      }
    })

    return () => {
      unsubscribe()
      writeContext = null
    }
  }

  const writeUtils = createWriteUtils<any, string | number, any>(
    () => writeContext,
  )

  const utils: QueryUnionCollectionUtils<T, TKey> = {
    invalidate: (queryKey?: QueryKey) =>
      queryClient.invalidateQueries({
        queryKey: queryKey ?? invalidationPrefix,
      }),

    ensureItem: async (key: TKey) => {
      // Already in the union (from any matching query) — no fetch needed.
      const existing = writeContext?.collection._state.syncedData.get(key)
      if (existing !== undefined) return existing as T

      if (!itemQueryKey || !itemQueryFn) {
        throw new Error(
          `[QueryUnionCollection] ensureItem requires both itemQueryKey and ` +
            `itemQueryFn to be configured.`,
        )
      }

      const data = await queryClient.ensureQueryData({
        queryKey: itemQueryKey(key),
        queryFn: () => itemQueryFn(key),
        ...(itemStaleTime !== undefined ? { staleTime: itemStaleTime } : {}),
      })
      return data as T
    },

    has: (key: TKey) =>
      writeContext?.collection._state.syncedData.has(key) ?? false,

    activeQueryKeys: () =>
      queryClient
        .getQueryCache()
        .getAll()
        .filter((query) => matches(query.queryKey))
        .map((query) => query.queryKey),

    writeInsert: writeUtils.writeInsert,
    writeUpdate: writeUtils.writeUpdate,
    writeDelete: writeUtils.writeDelete,
    writeUpsert: writeUtils.writeUpsert,
    writeBatch: writeUtils.writeBatch,
  }

  return {
    ...baseCollectionConfig,
    getKey,
    sync: { sync: internalSync },
    utils,
  } as CollectionConfig<T, TKey, TSchema> & {
    schema?: TSchema
    utils: QueryUnionCollectionUtils<T, TKey>
  }
}
