import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  worktreeListMock
} from '../worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

// Why: design §4.4 — hydration purge gated on per-repo success (F1 regression) so a git error can't wipe tabsByWorktree.
describe('fetchAllWorktrees hydration-time purge (design §4.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  const repoA = {
    id: 'repoA',
    path: '/repos/a',
    displayName: 'a',
    badgeColor: '#000',
    addedAt: 0
  }
  const repoB = {
    id: 'repoB',
    path: '/repos/b',
    displayName: 'b',
    badgeColor: '#111',
    addedAt: 0
  }

  it('defers the purge when a sibling repo fetch fails (F1 regression)', async () => {
    const store = createTestStore()
    const wtA = makeWorktree({ id: 'repoA::/a/wt1', repoId: 'repoA', path: '/a/wt1' })
    const wtB = makeWorktree({ id: 'repoB::/b/wt1', repoId: 'repoB', path: '/b/wt1' })

    // repoA succeeds, repoB throws; a stale tabsByWorktree entry must NOT be purged while any repo fetch is degraded.
    worktreeListMock.mockImplementation(async ({ repoId }: { repoId: string }) => {
      if (repoId === 'repoA') {
        return [wtA]
      }
      throw new Error('git error')
    })

    store.setState({
      repos: [repoA, repoB],
      worktreesByRepo: { repoB: [wtB] },
      tabsByWorktree: {
        'repoA::/a/stale': [{ id: 'tab-A-stale', worktreeId: 'repoA::/a/stale' }],
        'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(false)
    expect(store.getState().tabsByWorktree).toEqual({
      'repoA::/a/stale': [{ id: 'tab-A-stale', worktreeId: 'repoA::/a/stale' }],
      'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
    })

    // After repoB recovers, the deferred purge fires for genuinely stale ids.
    worktreeListMock.mockImplementation(async ({ repoId }: { repoId: string }) => {
      if (repoId === 'repoA') {
        return [wtA]
      }
      return [wtB]
    })

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(true)
    expect(store.getState().tabsByWorktree).toEqual({
      'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
    })
  })

  it('preserves floating workspace state while purging a real stale worktree', async () => {
    const store = createTestStore()
    const wtA = makeWorktree({ id: 'repoA::/a/wt1', repoId: 'repoA', path: '/a/wt1' })
    const wtB = makeWorktree({ id: 'repoB::/b/wt1', repoId: 'repoB', path: '/b/wt1' })
    const staleId = 'repoA::/a/zombie'
    const floatingFile = {
      id: 'floating-file',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      filePath: '/floating/note.md',
      relativePath: 'note.md',
      language: 'markdown',
      isDirty: false,
      isPreview: false,
      mode: 'edit' as const
    }

    worktreeListMock.mockImplementation(async ({ repoId }: { repoId: string }) =>
      repoId === 'repoA' ? [wtA] : [wtB]
    )

    store.setState({
      repos: [repoA, repoB],
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeFileId: 'floating-file',
      activeTabId: 'floating-terminal-tab',
      activeTabType: 'editor' as const,
      tabsByWorktree: {
        [wtA.id]: [{ id: 'tab-A', worktreeId: wtA.id }],
        [staleId]: [{ id: 'tab-zombie', worktreeId: staleId }],
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          { id: 'floating-terminal-tab', worktreeId: FLOATING_TERMINAL_WORKTREE_ID }
        ]
      },
      browserTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [{ id: 'floating-browser', url: 'https://orca.test' }]
      },
      activeBrowserTabIdByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-browser'
      },
      openFiles: [
        floatingFile,
        {
          id: 'stale-file',
          worktreeId: staleId,
          filePath: '/a/zombie/stale.ts',
          relativePath: 'stale.ts',
          language: 'typescript',
          isDirty: false,
          isPreview: false,
          mode: 'edit' as const
        }
      ],
      activeFileIdByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-file',
        [staleId]: 'stale-file'
      },
      unifiedTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: 'floating-unified-tab',
            type: 'editor',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            fileId: 'floating-file'
          }
        ],
        [staleId]: [{ id: 'stale-unified-tab', worktreeId: staleId }]
      },
      groupsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: 'floating-group',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            activeTabId: 'floating-unified-tab'
          }
        ],
        [staleId]: [{ id: 'stale-group', worktreeId: staleId, activeTabId: 'stale-unified-tab' }]
      },
      layoutByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: { type: 'leaf', groupId: 'floating-group' },
        [staleId]: { type: 'leaf', groupId: 'stale-group' }
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(true)
    expect(store.getState().tabsByWorktree).toEqual({
      [wtA.id]: [{ id: 'tab-A', worktreeId: wtA.id }],
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        { id: 'floating-terminal-tab', worktreeId: FLOATING_TERMINAL_WORKTREE_ID }
      ]
    })
    expect(store.getState().browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual([
      { id: 'floating-browser', url: 'https://orca.test' }
    ])
    expect(store.getState().openFiles).toEqual([floatingFile])
    expect(store.getState().activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(
      'floating-file'
    )
    expect(store.getState().unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
    expect(store.getState().groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
    expect(store.getState().layoutByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual({
      type: 'leaf',
      groupId: 'floating-group'
    })
    expect(store.getState().activeWorktreeId).toBe(FLOATING_TERMINAL_WORKTREE_ID)
    expect(store.getState().activeFileId).toBe('floating-file')
    expect(store.getState().activeTabId).toBe('floating-terminal-tab')
    expect(store.getState().activeTabType).toBe('editor')
  })
})
