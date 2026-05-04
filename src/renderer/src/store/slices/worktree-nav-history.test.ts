import { createStore, type StoreApi } from 'zustand/vanilla'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import type { Worktree } from '../../../../shared/types'
import {
  canGoBackWorktreeHistory,
  canGoForwardWorktreeHistory,
  createWorktreeNavHistorySlice,
  findPrevLiveWorktreeHistoryIndex,
  setWorktreeNavActivator,
  setWorktreeNavViewActivator
} from './worktree-nav-history'

type MinimalState = Pick<
  AppState,
  | 'worktreeNavHistory'
  | 'worktreeNavHistoryIndex'
  | 'isNavigatingHistory'
  | 'recordWorktreeVisit'
  | 'recordViewVisit'
  | 'goBackWorktree'
  | 'goForwardWorktree'
  | 'worktreesByRepo'
>

function makeWorktree(id: string): Worktree {
  // Only `id` is read by findWorktreeById, which is what the slice uses for
  // live-entry checks. Cast covers fields irrelevant to these tests.
  return { id } as unknown as Worktree
}

function createHistoryStore(worktreeIds: string[] = []): StoreApi<MinimalState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((set, get, api) => ({
    worktreesByRepo: {
      'repo-1': worktreeIds.map(makeWorktree)
    },
    ...createWorktreeNavHistorySlice(
      set as Parameters<typeof createWorktreeNavHistorySlice>[0],
      get as Parameters<typeof createWorktreeNavHistorySlice>[1],
      api as Parameters<typeof createWorktreeNavHistorySlice>[2]
    )
  })) as unknown as StoreApi<MinimalState>
}

describe('worktree-nav-history slice: recordWorktreeVisit', () => {
  it('appends new entries and advances the index', () => {
    const store = createHistoryStore()
    store.getState().recordWorktreeVisit('a')
    store.getState().recordWorktreeVisit('b')
    store.getState().recordWorktreeVisit('c')

    expect(store.getState().worktreeNavHistory).toEqual(['a', 'b', 'c'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(2)
  })

  it('de-dupes only the current entry (A -> B -> A is valid)', () => {
    const store = createHistoryStore()
    store.getState().recordWorktreeVisit('a')
    store.getState().recordWorktreeVisit('b')
    store.getState().recordWorktreeVisit('a')
    // A repeated activation of the current entry is a no-op
    store.getState().recordWorktreeVisit('a')

    expect(store.getState().worktreeNavHistory).toEqual(['a', 'b', 'a'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(2)
  })

  it('truncates forward entries when recording from a non-head index', () => {
    const store = createHistoryStore(['a', 'b', 'c'])
    store.getState().recordWorktreeVisit('a')
    store.getState().recordWorktreeVisit('b')
    store.getState().recordWorktreeVisit('c')
    // Move index back to 'a' (simulate two back presses)
    store.setState({ worktreeNavHistoryIndex: 0 })
    // New navigation truncates 'b' and 'c' from the forward stack
    store.getState().recordWorktreeVisit('d')

    expect(store.getState().worktreeNavHistory).toEqual(['a', 'd'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)
  })

  it('caps the history at 50 entries, evicting oldest', () => {
    const store = createHistoryStore()
    for (let i = 0; i < 60; i++) {
      store.getState().recordWorktreeVisit(`w${i}`)
    }
    const state = store.getState()
    expect(state.worktreeNavHistory).toHaveLength(50)
    // Oldest 10 are evicted; the head is the most recent.
    expect(state.worktreeNavHistory[0]).toBe('w10')
    expect(state.worktreeNavHistory[49]).toBe('w59')
    expect(state.worktreeNavHistoryIndex).toBe(49)
  })
})

describe('worktree-nav-history slice: goBack / goForward', () => {
  // Why: reset the module-level activator after every test so a mid-test
  // throw cannot leak mock state into sibling tests in the same worker.
  afterEach(() => {
    setWorktreeNavActivator(null)
  })

  it('moves the index without mutating the history array on success', () => {
    const store = createHistoryStore(['a', 'b', 'c'])
    // Install activator that simulates a successful activation.
    setWorktreeNavActivator(() => ({ primaryTabId: null }))

    store.getState().recordWorktreeVisit('a')
    store.getState().recordWorktreeVisit('b')
    store.getState().recordWorktreeVisit('c')

    store.getState().goBackWorktree()
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)
    expect(store.getState().worktreeNavHistory).toEqual(['a', 'b', 'c'])
    expect(store.getState().isNavigatingHistory).toBe(false)

    store.getState().goForwardWorktree()
    expect(store.getState().worktreeNavHistoryIndex).toBe(2)
  })

  it('leaves the index untouched when activator returns false', () => {
    const store = createHistoryStore(['a', 'b', 'c'])
    setWorktreeNavActivator(() => false)

    store.getState().recordWorktreeVisit('a')
    store.getState().recordWorktreeVisit('b')

    store.getState().goBackWorktree()
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)
    expect(store.getState().isNavigatingHistory).toBe(false)
  })

  it('skips deleted worktrees when searching for the prev live entry', () => {
    // Only 'a' and 'c' remain in worktreesByRepo; 'b' was deleted.
    const store = createHistoryStore(['a', 'c'])
    const activated: string[] = []
    setWorktreeNavActivator((id) => {
      activated.push(id as string)
      return { primaryTabId: null }
    })

    store.setState({
      worktreeNavHistory: ['a', 'b', 'c'],
      worktreeNavHistoryIndex: 2
    })

    store.getState().goBackWorktree()
    expect(activated).toEqual(['a'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(0)
  })

  it('no-ops when the entire direction is dead', () => {
    // All prior entries point at deleted worktrees.
    const store = createHistoryStore(['c'])
    const activated: string[] = []
    setWorktreeNavActivator((id) => {
      activated.push(id as string)
      return { primaryTabId: null }
    })

    store.setState({
      worktreeNavHistory: ['a', 'b', 'c'],
      worktreeNavHistoryIndex: 2
    })

    store.getState().goBackWorktree()
    expect(activated).toEqual([])
    expect(store.getState().worktreeNavHistoryIndex).toBe(2)
  })

  it('two rapid back presses each decrement the index by one', () => {
    const store = createHistoryStore(['a', 'b', 'c'])
    setWorktreeNavActivator(() => ({ primaryTabId: null }))

    store.getState().recordWorktreeVisit('a')
    store.getState().recordWorktreeVisit('b')
    store.getState().recordWorktreeVisit('c')

    store.getState().goBackWorktree()
    store.getState().goBackWorktree()

    expect(store.getState().worktreeNavHistoryIndex).toBe(0)
    expect(store.getState().isNavigatingHistory).toBe(false)
  })
})

describe('worktree-nav-history slice: Tasks entries', () => {
  afterEach(() => {
    setWorktreeNavActivator(null)
    setWorktreeNavViewActivator(null)
  })

  it('A -> Tasks -> B, back lands on Tasks then A', () => {
    const store = createHistoryStore(['a', 'b'])
    const activated: string[] = []
    const viewed: string[] = []
    setWorktreeNavActivator((id) => {
      activated.push(id as string)
      return { primaryTabId: null }
    })
    setWorktreeNavViewActivator((v) => {
      viewed.push(v)
    })

    store.getState().recordWorktreeVisit('a')
    store.getState().recordViewVisit('tasks')
    store.getState().recordWorktreeVisit('b')

    expect(store.getState().worktreeNavHistory).toEqual(['a', 'tasks', 'b'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(2)

    store.getState().goBackWorktree()
    expect(viewed).toEqual(['tasks'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)

    store.getState().goBackWorktree()
    expect(activated).toEqual(['a'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(0)
  })

  it('dedupes Tasks against the current Tasks entry', () => {
    const store = createHistoryStore(['a'])
    store.getState().recordWorktreeVisit('a')
    store.getState().recordViewVisit('tasks')
    store.getState().recordViewVisit('tasks')
    store.getState().recordViewVisit('tasks')

    expect(store.getState().worktreeNavHistory).toEqual(['a', 'tasks'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)
  })

  it('skips a dead worktree between two Tasks entries', () => {
    // 'b' is deleted; history is [tasks, b, tasks].
    const store = createHistoryStore([])
    const viewed: string[] = []
    setWorktreeNavViewActivator((v) => {
      viewed.push(v)
    })

    store.setState({
      worktreeNavHistory: ['tasks', 'b', 'tasks'],
      worktreeNavHistoryIndex: 2
    })

    store.getState().goBackWorktree()
    expect(viewed).toEqual(['tasks'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(0)
  })

  it('closeTaskPage-style rewind: A -> Tasks, rewind moves index to A', () => {
    const store = createHistoryStore(['a'])
    store.getState().recordWorktreeVisit('a')
    store.getState().recordViewVisit('tasks')
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)

    // Simulate closeTaskPage's rewind logic.
    const prev = findPrevLiveWorktreeHistoryIndex(store.getState() as AppState)
    expect(prev).toBe(0)
    store.setState({ worktreeNavHistoryIndex: prev ?? store.getState().worktreeNavHistoryIndex })

    // Forward re-opens Tasks.
    setWorktreeNavActivator(() => ({ primaryTabId: null }))
    const viewed: string[] = []
    setWorktreeNavViewActivator((v) => {
      viewed.push(v)
    })

    store.getState().goForwardWorktree()
    expect(viewed).toEqual(['tasks'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)
  })

  it('closeTaskPage-style rewind with only-Tasks history leaves index at 0', () => {
    const store = createHistoryStore([])
    store.getState().recordViewVisit('tasks')
    expect(store.getState().worktreeNavHistoryIndex).toBe(0)

    const prev = findPrevLiveWorktreeHistoryIndex(store.getState() as AppState)
    expect(prev).toBeNull()
    // closeTaskPage leaves the index unchanged when there's no prior live entry.
    expect(store.getState().worktreeNavHistoryIndex).toBe(0)
  })
})

describe('worktree-nav-history selectors', () => {
  it('reports back availability only when a live prior entry exists', () => {
    const store = createHistoryStore(['c'])
    store.setState({
      worktreeNavHistory: ['a', 'b', 'c'],
      worktreeNavHistoryIndex: 2
    })

    expect(canGoBackWorktreeHistory(store.getState() as AppState)).toBe(false)

    store.setState({
      worktreesByRepo: {
        'repo-1': [makeWorktree('a'), makeWorktree('c')]
      }
    })

    expect(canGoBackWorktreeHistory(store.getState() as AppState)).toBe(true)
  })

  it('reports forward availability only when a live next entry exists', () => {
    const store = createHistoryStore(['a'])
    store.setState({
      worktreeNavHistory: ['a', 'b', 'c'],
      worktreeNavHistoryIndex: 0
    })

    expect(canGoForwardWorktreeHistory(store.getState() as AppState)).toBe(false)

    store.setState({
      worktreesByRepo: {
        'repo-1': [makeWorktree('a'), makeWorktree('c')]
      }
    })

    expect(canGoForwardWorktreeHistory(store.getState() as AppState)).toBe(true)
  })
})
