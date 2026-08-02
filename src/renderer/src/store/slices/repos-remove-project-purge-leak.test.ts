/**
 * Memory-leak regression: removing a project must purge its worktrees' per-worktree
 * state.
 *
 * `removeProject` hand-deleted only a small subset of per-worktree maps
 * (tabsByWorktree, terminalLayoutsByTabId, ptyIdsByTabId, …) and never called the
 * canonical `purgeWorktreeTerminalState` / `buildWorktreePurgeState`. So ~30+
 * worktree-scoped maps (unifiedTabsByWorktree, groupsByWorktree, layoutByWorktree,
 * gitStatusByWorktree, gitStatusHugeByWorktree, browserTabsByWorktree,
 * everActivatedWorktreeIds, …) kept an entry for every worktree of every removed
 * project. No background reaper recovers them (fetchWorktrees never runs again for a
 * removed repo). Repos churn forever and each can own many worktrees, so the state
 * grew monotonically. The single `removeWorktree` path already routes through
 * `purgeWorktreeTerminalState`; project removal did not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTestStore, makeWorktree } from './store-test-helpers'
import type { Repo } from '../../../../shared/types'

const repo1: Repo = { id: 'repo-1', path: '/r1', displayName: 'R1', badgeColor: '#000', addedAt: 1 }
const repo2: Repo = { id: 'repo-2', path: '/r2', displayName: 'R2', badgeColor: '#111', addedAt: 2 }

const reposRemove = vi.fn().mockResolvedValue(undefined)
const ptyKill = vi.fn()

beforeEach(() => {
  reposRemove.mockReset().mockResolvedValue(undefined)
  ptyKill.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: { remove: reposRemove },
      pty: { kill: ptyKill },
      runtimeEnvironments: { call: vi.fn() }
    }
  })
})

const W1 = 'repo-1::/r1/wt1'
const W2 = 'repo-2::/r2/wt1'

function seedTwoProjects(store: ReturnType<typeof createTestStore>): void {
  store.setState({
    repos: [repo1, repo2],
    worktreesByRepo: {
      [repo1.id]: [makeWorktree({ id: W1, repoId: repo1.id, path: '/r1/wt1' })],
      [repo2.id]: [makeWorktree({ id: W2, repoId: repo2.id, path: '/r2/wt1' })]
    },
    // Per-worktree maps that removeProject previously left behind.
    unifiedTabsByWorktree: { [W1]: [], [W2]: [] },
    groupsByWorktree: { [W1]: [], [W2]: [] },
    browserTabsByWorktree: { [W1]: [], [W2]: [] },
    gitStatusHugeByWorktree: { [W1]: { limit: 1000 }, [W2]: { limit: 2000 } },
    everActivatedWorktreeIds: new Set([W1, W2])
  })
}

describe('removeProject purges per-worktree state (leak regression)', () => {
  it('drops every per-worktree map entry for the removed project', async () => {
    const store = createTestStore()
    seedTwoProjects(store)

    await store.getState().removeProject(repo1.id)

    const s = store.getState()
    // Removed project's worktree is purged from every map.
    expect(s.unifiedTabsByWorktree[W1]).toBeUndefined()
    expect(s.groupsByWorktree[W1]).toBeUndefined()
    expect(s.browserTabsByWorktree[W1]).toBeUndefined()
    expect(s.gitStatusHugeByWorktree[W1]).toBeUndefined()
    expect(s.everActivatedWorktreeIds.has(W1)).toBe(false)
  })

  it('keeps per-worktree state for projects that are NOT removed', async () => {
    const store = createTestStore()
    seedTwoProjects(store)

    await store.getState().removeProject(repo1.id)

    const s = store.getState()
    // Surviving project's worktree state is untouched (guard over-eviction).
    expect(s.unifiedTabsByWorktree[W2]).toBeDefined()
    expect(s.groupsByWorktree[W2]).toBeDefined()
    expect(s.browserTabsByWorktree[W2]).toBeDefined()
    expect(s.gitStatusHugeByWorktree[W2]).toEqual({ limit: 2000 })
    expect(s.everActivatedWorktreeIds.has(W2)).toBe(true)
  })
})
