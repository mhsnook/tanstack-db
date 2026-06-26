import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/query-core'
import { createCollection } from '@tanstack/db'
import { stripVirtualProps } from '../../db/tests/utils'
import {
  WILDCARD,
  keyMatchesPattern,
  queryUnionCollectionOptions,
} from '../src/query-union'

interface Card {
  id: string
  lang?: string
  status?: string
}

const getKey = (card: Card) => card.id

describe(`keyMatchesPattern`, () => {
  it(`prefix-matches with a trailing wildcard`, () => {
    const pattern = [`user_card`, WILDCARD]
    expect(keyMatchesPattern([`user_card`, `mine`], pattern)).toBe(true)
    expect(keyMatchesPattern([`user_card`, `lang`, `hin`], pattern)).toBe(true)
    expect(keyMatchesPattern([`user_card`, { status: `skipped` }], pattern)).toBe(
      true,
    )
    expect(keyMatchesPattern([`other`, `mine`], pattern)).toBe(false)
    // shorter than the pattern -> no match
    expect(keyMatchesPattern([`user_card`], pattern)).toBe(false)
  })

  it(`matches deeply on non-wildcard segments`, () => {
    const pattern = [`user_card`, `lang`, WILDCARD]
    expect(keyMatchesPattern([`user_card`, `lang`, `hin`], pattern)).toBe(true)
    expect(keyMatchesPattern([`user_card`, `mine`, `x`], pattern)).toBe(false)
  })

  it(`treats a plain prefix as a prefix match`, () => {
    const pattern = [`user_card`]
    expect(keyMatchesPattern([`user_card`, `mine`], pattern)).toBe(true)
    expect(keyMatchesPattern([`user_card`], pattern)).toBe(true)
    expect(keyMatchesPattern([`deck`], pattern)).toBe(false)
  })
})

describe(`queryUnionCollectionOptions`, () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
  })

  afterEach(() => {
    queryClient.clear()
  })

  const makeCollection = () =>
    createCollection(
      queryUnionCollectionOptions<Card>({
        id: `cards`,
        queryClient,
        queryKey: [`user_card`, WILDCARD],
        getKey,
        startSync: true,
      }),
    )

  it(`folds multiple matching queries into one deduplicated collection`, async () => {
    const collection = makeCollection()

    await queryClient.ensureQueryData({
      queryKey: [`user_card`, `mine`],
      queryFn: (): Array<Card> => [
        { id: `1`, status: `new` },
        { id: `2`, status: `new` },
      ],
    })
    await queryClient.ensureQueryData({
      queryKey: [`user_card`, `lang`, `hin`],
      queryFn: (): Array<Card> => [
        { id: `2`, status: `new` }, // overlaps with the previous query
        { id: `3`, lang: `hin` },
      ],
    })

    await vi.waitFor(() => expect(collection.size).toBe(3))
    expect(stripVirtualProps(collection.get(`1`))).toEqual({
      id: `1`,
      status: `new`,
    })
    expect(stripVirtualProps(collection.get(`3`))).toEqual({
      id: `3`,
      lang: `hin`,
    })
  })

  it(`ignores queries that don't match the pattern`, async () => {
    const collection = makeCollection()

    await queryClient.ensureQueryData({
      queryKey: [`deck`, `mine`],
      queryFn: (): Array<Card> => [{ id: `99` }],
    })

    await Promise.resolve()
    expect(collection.size).toBe(0)
  })

  it(`picks up queries that were already in the cache before sync started`, async () => {
    // Seed the cache first...
    await queryClient.ensureQueryData({
      queryKey: [`user_card`, `mine`],
      queryFn: (): Array<Card> => [{ id: `1` }, { id: `2` }],
    })

    // ...then create the collection.
    const collection = makeCollection()

    await vi.waitFor(() => expect(collection.size).toBe(2))
  })

  it(`keeps a row while any query still owns it, removes it when the last owner drops`, async () => {
    const collection = makeCollection()

    await queryClient.ensureQueryData({
      queryKey: [`user_card`, `mine`],
      queryFn: (): Array<Card> => [{ id: `1` }, { id: `2` }],
    })
    await queryClient.ensureQueryData({
      queryKey: [`user_card`, `lang`, `hin`],
      queryFn: (): Array<Card> => [{ id: `2` }, { id: `3` }],
    })

    await vi.waitFor(() => expect(collection.size).toBe(3))

    // Drop the 'mine' query. id 1 was owned only by it -> gone.
    // id 2 is still owned by the 'hin' query -> stays.
    queryClient.removeQueries({ queryKey: [`user_card`, `mine`] })

    await vi.waitFor(() => expect(collection.size).toBe(2))
    expect(collection.has(`1`)).toBe(false)
    expect(collection.has(`2`)).toBe(true)
    expect(collection.has(`3`)).toBe(true)
  })

  it(`reflects updates to an existing query's rows`, async () => {
    const collection = makeCollection()

    let rows: Array<Card> = [{ id: `1`, status: `new` }]
    await queryClient.ensureQueryData({
      queryKey: [`user_card`, `mine`],
      queryFn: () => rows,
    })
    await vi.waitFor(() =>
      expect(collection.get(`1`)?.status).toBe(`new`),
    )

    rows = [{ id: `1`, status: `skipped` }]
    await queryClient.refetchQueries({ queryKey: [`user_card`, `mine`] })

    await vi.waitFor(() =>
      expect(collection.get(`1`)?.status).toBe(`skipped`),
    )
  })

  it(`folds single-item queries into the same union as list queries`, async () => {
    const collection = makeCollection()

    await queryClient.ensureQueryData({
      queryKey: [`user_card`, `mine`],
      queryFn: (): Array<Card> => [{ id: `1` }],
    })
    // A single-object result (not an array) is wrapped automatically.
    await queryClient.ensureQueryData({
      queryKey: [`user_card`, `id`, `2`],
      queryFn: (): Card => ({ id: `2`, status: `new` }),
    })

    await vi.waitFor(() => expect(collection.size).toBe(2))
    expect(stripVirtualProps(collection.get(`2`))).toEqual({
      id: `2`,
      status: `new`,
    })
  })

  describe(`getRowVersion conflict resolution`, () => {
    interface VersionedCard {
      id: string
      status: string
      updated_at: number
    }
    const getVersionedKey = (c: VersionedCard) => c.id

    const makeVersionedCollection = () =>
      createCollection(
        queryUnionCollectionOptions<VersionedCard>({
          id: `vcards`,
          queryClient,
          queryKey: [`user_card`, WILDCARD],
          getKey: getVersionedKey,
          getRowVersion: (c) => c.updated_at,
          startSync: true,
        }),
      )

    it(`does not let a stale, late-arriving query clobber newer data`, async () => {
      const collection = makeVersionedCollection()

      // Fast point query lands first with the NEWER row (updated_at: 200).
      await queryClient.ensureQueryData({
        queryKey: [`user_card`, `id`, `5`],
        queryFn: (): Array<VersionedCard> => [
          { id: `5`, status: `skipped`, updated_at: 200 },
        ],
      })
      await vi.waitFor(() => expect(collection.get(`5`)?.status).toBe(`skipped`))

      // Broad query resolves LATER but reflects an OLDER snapshot (updated_at: 100).
      await queryClient.ensureQueryData({
        queryKey: [`user_card`, `uid`, `u1`],
        queryFn: (): Array<VersionedCard> => [
          { id: `5`, status: `new`, updated_at: 100 },
          { id: `6`, status: `new`, updated_at: 100 },
        ],
      })

      await vi.waitFor(() => expect(collection.has(`6`)).toBe(true))
      // Row 5 keeps the newer value; the stale broad snapshot is rejected.
      expect(collection.get(`5`)?.status).toBe(`skipped`)
      expect(collection.get(`5`)?.updated_at).toBe(200)
      // ...but row 6 (new info, not a conflict) is still inserted.
      expect(collection.get(`6`)?.status).toBe(`new`)
    })

    it(`applies a genuinely newer version from any query`, async () => {
      const collection = makeVersionedCollection()

      await queryClient.ensureQueryData({
        queryKey: [`user_card`, `uid`, `u1`],
        queryFn: (): Array<VersionedCard> => [
          { id: `5`, status: `new`, updated_at: 100 },
        ],
      })
      await vi.waitFor(() => expect(collection.get(`5`)?.status).toBe(`new`))

      await queryClient.ensureQueryData({
        queryKey: [`user_card`, `id`, `5`],
        queryFn: (): Array<VersionedCard> => [
          { id: `5`, status: `skipped`, updated_at: 300 },
        ],
      })
      await vi.waitFor(() =>
        expect(collection.get(`5`)?.status).toBe(`skipped`),
      )
      expect(collection.get(`5`)?.updated_at).toBe(300)
    })
  })

  describe(`utils.ensureItem`, () => {
    it(`returns a present item without fetching`, async () => {
      const itemQueryFn = vi.fn(
        (key: string | number): Card => ({ id: String(key) }),
      )
      const collection = createCollection(
        queryUnionCollectionOptions<Card>({
          id: `cards`,
          queryClient,
          queryKey: [`user_card`, WILDCARD],
          getKey,
          startSync: true,
          itemQueryKey: (key) => [`user_card`, `id`, key],
          itemQueryFn,
        }),
      )

      await queryClient.ensureQueryData({
        queryKey: [`user_card`, `mine`],
        queryFn: (): Array<Card> => [{ id: `1`, status: `new` }],
      })
      await vi.waitFor(() => expect(collection.has(`1`)).toBe(true))

      const item = await collection.utils.ensureItem(`1`)
      expect(stripVirtualProps(item as Card)).toEqual({ id: `1`, status: `new` })
      expect(itemQueryFn).not.toHaveBeenCalled()
    })

    it(`fetches a missing item via itemQueryFn`, async () => {
      const itemQueryFn = vi.fn(
        (key: string | number): Card => ({ id: String(key), status: `fetched` }),
      )
      const collection = createCollection(
        queryUnionCollectionOptions<Card>({
          id: `cards`,
          queryClient,
          queryKey: [`user_card`, WILDCARD],
          getKey,
          startSync: true,
          itemQueryKey: (key) => [`user_card`, `id`, key],
          itemQueryFn,
        }),
      )

      const item = await collection.utils.ensureItem(`7`)
      expect(itemQueryFn).toHaveBeenCalledWith(`7`)
      expect((item as Card).status).toBe(`fetched`)

      // It also flowed into the union because its key matches the pattern.
      await vi.waitFor(() => expect(collection.has(`7`)).toBe(true))
    })

    it(`throws when itemQueryFn/itemQueryKey are not configured`, async () => {
      const collection = makeCollection()
      await expect(collection.utils.ensureItem(`x`)).rejects.toThrow(
        /ensureItem requires/,
      )
    })
  })

  it(`utils.invalidate marks matching queries stale so they re-pull on next read`, async () => {
    const collection = makeCollection()
    const queryFn = vi.fn((): Array<Card> => [{ id: `1` }])

    await queryClient.ensureQueryData({ queryKey: [`user_card`, `mine`], queryFn })
    await vi.waitFor(() => expect(collection.has(`1`)).toBe(true))
    expect(queryFn).toHaveBeenCalledTimes(1)

    // The union holds no observers, so invalidate marks queries stale rather
    // than eagerly refetching (idiomatic React Query). The next read re-pulls.
    await collection.utils.invalidate()
    expect(
      queryClient.getQueryState([`user_card`, `mine`])?.isInvalidated,
    ).toBe(true)

    // A loader-style fetch now re-pulls because the entry is stale.
    await queryClient.fetchQuery({ queryKey: [`user_card`, `mine`], queryFn })
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  it(`utils.activeQueryKeys lists the matching query keys`, async () => {
    const collection = makeCollection()
    await queryClient.ensureQueryData({
      queryKey: [`user_card`, `mine`],
      queryFn: (): Array<Card> => [{ id: `1` }],
    })
    await queryClient.ensureQueryData({
      queryKey: [`deck`, `mine`],
      queryFn: (): Array<Card> => [{ id: `2` }],
    })
    await vi.waitFor(() => expect(collection.has(`1`)).toBe(true))

    const keys = collection.utils.activeQueryKeys()
    expect(keys).toContainEqual([`user_card`, `mine`])
    expect(keys).not.toContainEqual([`deck`, `mine`])
  })
})
