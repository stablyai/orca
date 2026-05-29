import { createStore, type StoreApi } from 'zustand/vanilla'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import type { GitHubWorkItem, Worktree } from '../../../../shared/types'
import {
  createWorktreeNavHistorySlice,
  findPrevLiveWorktreeHistoryIndex,
  setWorktreeNavActivator,
  setWorktreeNavViewActivator,
  type WorktreeNavHistorySimpleViewEntry
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

const viewCases: { entry: WorktreeNavHistorySimpleViewEntry; label: string }[] = [
  { entry: 'tasks', label: 'Tasks' },
  { entry: 'automations', label: 'Automations' }
]

function makeGitHubWorkItem(overrides: Partial<GitHubWorkItem> = {}): GitHubWorkItem {
  return {
    id: 'pr-95',
    type: 'pr',
    number: 95,
    title: 'feat: add file upload command',
    state: 'open',
    url: 'https://github.com/acme/repo/pull/95',
    labels: [],
    updatedAt: '2026-05-20T00:00:00.000Z',
    author: 'octocat',
    repoId: 'repo-1',
    ...overrides
  }
}

describe('worktree-nav-history slice: view entries', () => {
  afterEach(() => {
    setWorktreeNavActivator(null)
    setWorktreeNavViewActivator(null)
  })

  for (const { entry, label } of viewCases) {
    it(`A -> ${label} -> B, back lands on ${label} then A`, () => {
      const store = createHistoryStore(['a', 'b'])
      const activated: string[] = []
      const viewed: WorktreeNavHistorySimpleViewEntry[] = []
      setWorktreeNavActivator((id) => {
        activated.push(id as string)
        return { primaryTabId: null }
      })
      setWorktreeNavViewActivator((v) => {
        viewed.push(v as WorktreeNavHistorySimpleViewEntry)
      })

      store.getState().recordWorktreeVisit('a')
      store.getState().recordViewVisit(entry)
      store.getState().recordWorktreeVisit('b')

      expect(store.getState().worktreeNavHistory).toEqual(['a', entry, 'b'])
      expect(store.getState().worktreeNavHistoryIndex).toBe(2)

      store.getState().goBackWorktree()
      expect(viewed).toEqual([entry])
      expect(store.getState().worktreeNavHistoryIndex).toBe(1)

      store.getState().goBackWorktree()
      expect(activated).toEqual(['a'])
      expect(store.getState().worktreeNavHistoryIndex).toBe(0)
    })

    it(`dedupes ${label} against the current ${label} entry`, () => {
      const store = createHistoryStore(['a'])
      store.getState().recordWorktreeVisit('a')
      store.getState().recordViewVisit(entry)
      store.getState().recordViewVisit(entry)
      store.getState().recordViewVisit(entry)

      expect(store.getState().worktreeNavHistory).toEqual(['a', entry])
      expect(store.getState().worktreeNavHistoryIndex).toBe(1)
    })

    it(`skips a dead worktree when backing to a prior ${label} entry`, () => {
      const store = createHistoryStore([])
      const viewed: WorktreeNavHistorySimpleViewEntry[] = []
      setWorktreeNavViewActivator((v) => {
        viewed.push(v as WorktreeNavHistorySimpleViewEntry)
      })

      store.setState({
        worktreeNavHistory: [entry, 'b', entry],
        worktreeNavHistoryIndex: 2
      })

      store.getState().goBackWorktree()
      expect(viewed).toEqual([entry])
      expect(store.getState().worktreeNavHistoryIndex).toBe(0)
    })

    it(`close-page-style rewind for ${label} preserves forward replay`, () => {
      const store = createHistoryStore(['a'])
      store.getState().recordWorktreeVisit('a')
      store.getState().recordViewVisit(entry)
      expect(store.getState().worktreeNavHistoryIndex).toBe(1)

      const prev = findPrevLiveWorktreeHistoryIndex(store.getState() as AppState)
      expect(prev).toBe(0)
      store.setState({ worktreeNavHistoryIndex: prev ?? store.getState().worktreeNavHistoryIndex })

      const viewed: WorktreeNavHistorySimpleViewEntry[] = []
      setWorktreeNavViewActivator((v) => {
        viewed.push(v as WorktreeNavHistorySimpleViewEntry)
      })

      store.getState().goForwardWorktree()
      expect(viewed).toEqual([entry])
      expect(store.getState().worktreeNavHistoryIndex).toBe(1)
    })
  }

  it('replays task detail entries through the same back/forward stack', () => {
    const store = createHistoryStore(['a'])
    const detail = {
      kind: 'task-detail',
      source: 'github',
      workItem: makeGitHubWorkItem(),
      initialTab: 'checks'
    } as const
    const viewed: unknown[] = []
    setWorktreeNavViewActivator((v) => {
      viewed.push(v)
    })

    store.getState().recordWorktreeVisit('a')
    store.getState().recordViewVisit('tasks')
    store.getState().recordViewVisit(detail)

    expect(store.getState().worktreeNavHistory).toEqual(['a', 'tasks', detail])
    expect(store.getState().worktreeNavHistoryIndex).toBe(2)

    store.getState().goBackWorktree()
    expect(viewed).toEqual(['tasks'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)

    store.getState().goForwardWorktree()
    expect(viewed).toEqual(['tasks', detail])
    expect(store.getState().worktreeNavHistoryIndex).toBe(2)
  })
})
