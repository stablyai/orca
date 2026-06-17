import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { TrelloCard, TrelloComment } from '../../../../shared/trello-types'
import { createTrelloSlice } from './trello'
import {
  clearTrelloInflight,
  inflightCardRequests,
  createInitialTrelloState
} from './trello-cache-state'

// ─── Mocks ──────────────────────────────────────────────────────────
const mockTrelloGetCard = vi.fn()
const mockTrelloCardComments = vi.fn()
const mockTrelloAddCardComment = vi.fn()
const mockTrelloStatus = vi.fn()
const mockTrelloListBoards = vi.fn()
const mockTrelloListLists = vi.fn()
const mockTrelloListBoardMembers = vi.fn()
const mockTrelloListBoardLabels = vi.fn()

vi.mock('@/runtime/runtime-trello-client', () => ({
  trelloGetCard: (...args: unknown[]) => mockTrelloGetCard(...args),
  trelloCardComments: (...args: unknown[]) => mockTrelloCardComments(...args),
  trelloAddCardComment: (...args: unknown[]) => mockTrelloAddCardComment(...args),
  trelloSearchCards: (...args: unknown[]) => mockTrelloGetCard(...args),
  trelloListCards: (...args: unknown[]) => mockTrelloGetCard(...args),
  trelloStatus: (...args: unknown[]) => mockTrelloStatus(...args),
  trelloConnect: vi.fn(),
  trelloDisconnect: vi.fn(),
  trelloTestConnection: vi.fn(),
  trelloListBoards: (...args: unknown[]) => mockTrelloListBoards(...args),
  trelloListLists: (...args: unknown[]) => mockTrelloListLists(...args),
  trelloListBoardMembers: (...args: unknown[]) => mockTrelloListBoardMembers(...args),
  trelloListBoardLabels: (...args: unknown[]) => mockTrelloListBoardLabels(...args)
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/trello-authenticated-images', () => ({ clearTrelloImageCache: vi.fn() }))

// ─── Helpers ─────────────────────────────────────────────────────────
function card(id: string, overrides?: Partial<TrelloCard>): TrelloCard {
  return {
    id,
    shortId: id,
    shortLink: id,
    name: `Card ${id}`,
    desc: '',
    url: `https://trello.com/c/${id}`,
    shortUrl: `https://trello.com/c/${id}`,
    closed: false,
    dueComplete: false,
    due: null,
    idList: 'list-1',
    idBoard: 'board-1',
    labels: [],
    members: [],
    dateLastActivity: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function comment(id: string, overrides?: Partial<TrelloComment>): TrelloComment {
  return {
    id,
    text: `Comment ${id}`,
    date: '2026-01-01T00:00:00.000Z',
    dateLastEdited: null,
    memberCreator: { id: 'user-1', username: 'user1', fullName: 'User 1', avatarUrl: null },
    ...overrides
  }
}

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
        ...createTrelloSlice(...a)
      }) as AppState
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  clearTrelloInflight()
  mockTrelloStatus.mockResolvedValue({ connected: false, viewer: null })
})

// ─── Tests ───────────────────────────────────────────────────────────
describe('trello store', () => {
  describe('fetchTrelloCard force refresh', () => {
    it('bypasses cache and inflight when force is true', async () => {
      const store = createTestStore()
      const freshCard = card('c1', { name: 'Fresh' })

      store.setState({
        trelloCardCache: {
          c1: { data: card('c1', { name: 'Stale' }), fetchedAt: Date.now() - 120_000 }
        }
      })

      mockTrelloGetCard.mockResolvedValueOnce(freshCard)
      const result = await store.getState().fetchTrelloCard('c1', { force: true })
      expect(result?.name).toBe('Fresh')
      expect(mockTrelloGetCard).toHaveBeenCalledTimes(1)
      expect(store.getState().trelloCardCache.c1?.data?.name).toBe('Fresh')
    })

    it('bypasses inflight dedup when force is true', async () => {
      const store = createTestStore()
      mockTrelloGetCard.mockResolvedValue(card('c1'))

      const p1 = store.getState().fetchTrelloCard('c1', { force: true })
      const p2 = store.getState().fetchTrelloCard('c1', { force: true })
      await Promise.all([p1, p2])

      expect(mockTrelloGetCard).toHaveBeenCalledTimes(2)
    })

    it('uses cache when force is not set and cache is fresh', async () => {
      const store = createTestStore()
      store.setState({
        trelloCardCache: {
          c1: { data: card('c1', { name: 'Cached' }), fetchedAt: Date.now() }
        }
      })

      const result = await store.getState().fetchTrelloCard('c1')
      expect(result?.name).toBe('Cached')
      expect(mockTrelloGetCard).not.toHaveBeenCalled()
    })
  })

  describe('fetchTrelloComments error propagation', () => {
    it('rejects instead of returning empty array on network error', async () => {
      const store = createTestStore()
      mockTrelloCardComments.mockRejectedValueOnce(new Error('Network timeout'))

      await expect(store.getState().fetchTrelloComments('card-1')).rejects.toThrow(
        'Network timeout'
      )
    })

    it('returns cached data when cache is fresh', async () => {
      const store = createTestStore()
      const cachedComments = [comment('c1')]
      store.setState({
        trelloCommentsCache: {
          'card-1': { data: cachedComments, fetchedAt: Date.now() }
        }
      })

      const result = await store.getState().fetchTrelloComments('card-1')
      expect(result).toEqual(cachedComments)
      expect(mockTrelloCardComments).not.toHaveBeenCalled()
    })

    it('bypasses cache on force=true and fetches fresh', async () => {
      const store = createTestStore()
      store.setState({
        trelloCommentsCache: {
          'card-1': { data: [comment('stale')], fetchedAt: Date.now() }
        }
      })

      mockTrelloCardComments.mockResolvedValueOnce([comment('fresh')])
      const result = await store.getState().fetchTrelloComments('card-1', { force: true })
      expect(result).toEqual([comment('fresh')])
      expect(mockTrelloCardComments).toHaveBeenCalledWith(expect.anything(), 'card-1')
    })

    it('propagates auth errors instead of swallowing them', async () => {
      const store = createTestStore()
      mockTrelloCardComments.mockRejectedValueOnce(new Error('Unauthorized 401'))

      await expect(store.getState().fetchTrelloComments('card-1')).rejects.toThrow(
        'Unauthorized 401'
      )
    })
  })

  describe('addTrelloCardComment invalidation and refresh', () => {
    it('clears comments cache and triggers force refresh after successful comment', async () => {
      const store = createTestStore()
      store.setState({
        trelloCommentsCache: {
          'card-1': { data: [comment('old')], fetchedAt: Date.now() }
        }
      })

      // Deferred controls when the force-refresh response arrives
      let resolveRefresh!: (v: TrelloComment[]) => void
      const refreshDeferred = new Promise<TrelloComment[]>((r) => {
        resolveRefresh = r
      })

      mockTrelloAddCardComment.mockResolvedValueOnce({ ok: true, id: 'new-comment' })
      mockTrelloCardComments.mockReturnValueOnce(refreshDeferred)

      const result = await store.getState().addTrelloCardComment('card-1', 'Hello')
      expect(result).toEqual({ ok: true, id: 'new-comment' })

      // Cache should be cleared immediately (before refresh completes)
      expect(store.getState().trelloCommentsCache['card-1']).toBeUndefined()

      // Let the refresh resolve
      const freshComments = [comment('old'), comment('new')]
      resolveRefresh(freshComments)
      await vi.waitFor(() => {
        expect(store.getState().trelloCommentsCache['card-1']).toBeDefined()
      })
      expect(store.getState().trelloCommentsCache['card-1']?.data).toEqual(freshComments)
    })

    it('returns error result without refreshing when API call fails', async () => {
      const store = createTestStore()
      store.setState({
        trelloCommentsCache: {
          'card-1': { data: [comment('existing')], fetchedAt: Date.now() }
        }
      })

      mockTrelloAddCardComment.mockResolvedValueOnce({ ok: false, error: 'Rate limited' })

      const result = await store.getState().addTrelloCardComment('card-1', 'Hello')
      expect(result).toEqual({ ok: false, error: 'Rate limited' })
      expect(store.getState().trelloCommentsCache['card-1']?.data).toEqual([comment('existing')])
      expect(mockTrelloCardComments).not.toHaveBeenCalled()
    })
  })

  describe('patchTrelloCard cache updates', () => {
    it('updates card in card cache and marks stale', () => {
      const store = createTestStore()
      store.setState({
        trelloCardCache: {
          detail: { data: card('c1', { name: 'Original' }), fetchedAt: Date.now() }
        }
      })

      store.getState().patchTrelloCard('c1', { name: 'Patched' })

      const entry = store.getState().trelloCardCache.detail
      expect(entry?.data?.name).toBe('Patched')
      expect(entry?.fetchedAt).toBe(0)
    })

    it('updates card in search cache entries', () => {
      const store = createTestStore()
      store.setState({
        trelloSearchCache: {
          'search::query': {
            data: [card('c1', { name: 'Old' }), card('c2')],
            fetchedAt: Date.now()
          }
        }
      })

      store.getState().patchTrelloCard('c1', { name: 'New' })

      const entry = store.getState().trelloSearchCache['search::query']
      expect(entry?.data?.[0]?.name).toBe('New')
      expect(entry?.data?.[1]?.name).toBe('Card c2')
    })

    it('does not touch unrelated cards', () => {
      const store = createTestStore()
      store.setState({
        trelloCardCache: {
          detail: { data: card('c1', { name: 'Unchanged' }), fetchedAt: Date.now() }
        }
      })
      store.getState().patchTrelloCard('c999', { name: 'Wrong' })

      expect(store.getState().trelloCardCache.detail?.data?.name).toBe('Unchanged')
    })

    it('updates across multiple search cache entries', () => {
      const store = createTestStore()
      store.setState({
        trelloSearchCache: {
          'search::a': { data: [card('c1', { name: 'A-Old' })], fetchedAt: Date.now() },
          'search::b': {
            data: [card('c1', { name: 'B-Old' }), card('c2')],
            fetchedAt: Date.now()
          }
        }
      })
      store.getState().patchTrelloCard('c1', { name: 'Patched' })

      expect(store.getState().trelloSearchCache['search::a']?.data?.[0]?.name).toBe('Patched')
      expect(store.getState().trelloSearchCache['search::b']?.data?.[0]?.name).toBe('Patched')
      expect(store.getState().trelloSearchCache['search::b']?.data?.[1]?.name).toBe('Card c2')
    })
  })

  describe('runtime switch resets Trello state', () => {
    it('resets all Trello caches and status fields', () => {
      const store = createTestStore()
      store.setState({
        trelloStatus: {
          connected: true,
          viewer: { id: 'u1', username: 'me', displayName: 'Me' }
        },
        trelloStatusChecked: true,
        trelloCardCache: { c1: { data: card('c1'), fetchedAt: Date.now() } },
        trelloSearchCache: { 's::q': { data: [card('c1')], fetchedAt: Date.now() } },
        trelloBoardsCache: [{ id: 'b1', name: 'Board', url: '', shortUrl: '' }],
        trelloListsCache: {
          b1: [{ id: 'l1', name: 'List', idBoard: 'b1', closed: false, pos: 0 }]
        },
        trelloCommentsCache: { c1: { data: [comment('c1')], fetchedAt: Date.now() } },
        trelloBoardMembersCache: { b1: [] },
        trelloBoardLabelsCache: { b1: [] }
      })

      store.setState(createInitialTrelloState())

      expect(store.getState().trelloStatus.connected).toBe(false)
      expect(store.getState().trelloStatusChecked).toBe(false)
      expect(Object.keys(store.getState().trelloCardCache)).toHaveLength(0)
      expect(Object.keys(store.getState().trelloSearchCache)).toHaveLength(0)
      expect(store.getState().trelloBoardsCache).toBeNull()
      expect(Object.keys(store.getState().trelloListsCache)).toHaveLength(0)
      expect(Object.keys(store.getState().trelloCommentsCache)).toHaveLength(0)
    })

    it('clears inflight requests so stale promises do not shadow new ones', async () => {
      const store = createTestStore()
      let resolveHanging!: (v: TrelloCard) => void
      mockTrelloGetCard.mockReturnValueOnce(
        new Promise<TrelloCard>((r) => {
          resolveHanging = r
        })
      )

      store.getState().fetchTrelloCard('c1')
      expect(inflightCardRequests.size).toBe(1)

      clearTrelloInflight()
      expect(inflightCardRequests.size).toBe(0)

      mockTrelloGetCard.mockResolvedValueOnce(card('c1', { name: 'Fresh after switch' }))
      const fresh = await store.getState().fetchTrelloCard('c1')
      expect(fresh?.name).toBe('Fresh after switch')
      expect(mockTrelloGetCard).toHaveBeenCalledTimes(2)

      // Clean up the hanging promise
      resolveHanging(card('c1'))
    })
  })
  describe('stale response guard (cache generation)', () => {
    it('discards cache writes from fetchTrelloCard after generation bump', async () => {
      const store = createTestStore()
      // Start a slow fetch
      let resolveFetch!: (v: TrelloCard) => void
      mockTrelloGetCard.mockReturnValueOnce(
        new Promise<TrelloCard>((r) => {
          resolveFetch = r
        })
      )
      const promise = store.getState().fetchTrelloCard('c1')

      // Simulate runtime switch: bump generation and reset caches
      store.setState({
        ...createInitialTrelloState(),
        trelloCacheGeneration: store.getState().trelloCacheGeneration + 1
      })

      // Old fetch resolves — cache should NOT be repopulated
      resolveFetch(card('c1', { name: 'Stale from old runtime' }))
      await promise

      expect(store.getState().trelloCardCache['c1']).toBeUndefined()
    })

    it('discards cache writes from searchTrelloCards after generation bump', async () => {
      const store = createTestStore()
      let resolveSearch!: (v: TrelloCard[]) => void
      mockTrelloGetCard.mockReturnValueOnce(
        new Promise<TrelloCard[]>((r) => {
          resolveSearch = r
        })
      )
      const promise = store.getState().searchTrelloCards('query')

      store.setState({
        ...createInitialTrelloState(),
        trelloCacheGeneration: store.getState().trelloCacheGeneration + 1
      })

      resolveSearch([card('c1')])
      await promise

      expect(Object.keys(store.getState().trelloSearchCache)).toHaveLength(0)
    })

    it('discards cache writes from reference data after generation bump', async () => {
      const store = createTestStore()
      let resolveBoards!: (v: unknown[]) => void
      mockTrelloListBoards.mockReturnValueOnce(
        new Promise((r) => {
          resolveBoards = r
        })
      )
      const promise = store.getState().fetchTrelloBoards()

      store.setState({
        ...createInitialTrelloState(),
        trelloCacheGeneration: store.getState().trelloCacheGeneration + 1
      })

      resolveBoards([{ id: 'b1', name: 'Stale' }])
      await promise

      expect(store.getState().trelloBoardsCache).toBeNull()
    })
  })

  describe('error propagation', () => {
    it('fetchTrelloCard rejects instead of returning null', async () => {
      const store = createTestStore()
      mockTrelloGetCard.mockRejectedValueOnce(new Error('Network timeout'))
      await expect(store.getState().fetchTrelloCard('c1')).rejects.toThrow('Network timeout')
    })

    it('fetchTrelloCard updates auth status on 401 then rejects', async () => {
      const store = createTestStore()
      store.setState({
        trelloStatus: { connected: true, viewer: { id: 'u1', username: 'me', displayName: 'Me' } }
      })
      mockTrelloGetCard.mockRejectedValueOnce(new Error('Unauthorized 401'))

      await expect(store.getState().fetchTrelloCard('c1')).rejects.toThrow('Unauthorized 401')
      expect(store.getState().trelloStatus.connected).toBe(false)
    })

    it('searchTrelloCards rejects instead of returning empty array', async () => {
      const store = createTestStore()
      mockTrelloGetCard.mockRejectedValueOnce(new Error('Server error'))
      await expect(store.getState().searchTrelloCards('query')).rejects.toThrow('Server error')
    })

    it('listTrelloCards rejects instead of returning empty array', async () => {
      const store = createTestStore()
      mockTrelloGetCard.mockRejectedValueOnce(new Error('Server error'))
      await expect(store.getState().listTrelloCards()).rejects.toThrow('Server error')
    })

    it('fetchTrelloBoards rejects instead of returning empty array', async () => {
      const store = createTestStore()
      mockTrelloListBoards.mockRejectedValueOnce(new Error('Server error'))
      await expect(store.getState().fetchTrelloBoards()).rejects.toThrow('Server error')
    })

    it('fetchTrelloLists rejects instead of returning empty array', async () => {
      const store = createTestStore()
      mockTrelloListLists.mockRejectedValueOnce(new Error('Server error'))
      await expect(store.getState().fetchTrelloLists('b1')).rejects.toThrow('Server error')
    })
  })
})
