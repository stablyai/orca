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
import { createTestStore, makeTab, makeWorktree } from './store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'

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
    tabsByWorktree: {
      [W1]: [makeTab({ id: 'tab-w1', worktreeId: W1 })],
      [W2]: [makeTab({ id: 'tab-w2', worktreeId: W2 })]
    },
    // Flat tab-id lists in persisted UI: omitByTabId cannot reach them, and this path
    // never runs closeTab, which is the only other place they are pruned.
    sessionsGridTabOrder: ['tab-w1', 'tab-w2'],
    sessionsGridHiddenTabIds: ['tab-w1', 'tab-w2'],
    // Per-worktree maps that removeProject previously left behind.
    unifiedTabsByWorktree: { [W1]: [], [W2]: [] },
    groupsByWorktree: { [W1]: [], [W2]: [] },
    browserTabsByWorktree: { [W1]: [], [W2]: [] },
    gitStatusHugeByWorktree: { [W1]: { limit: 1000 }, [W2]: { limit: 2000 } },
    everActivatedWorktreeIds: new Set([W1, W2]),
    localDetectedAgentIdsByContext: {
      'repo-1:windows-host': ['claude'],
      'repo-2:windows-host': ['codex']
    }
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
    expect(s.localDetectedAgentIdsByContext['repo-1:windows-host']).toBeUndefined()
    // The two session-grid lists are persisted, so a stranded id is written to disk and
    // re-sent on every ui.set for the life of the profile.
    expect(s.sessionsGridTabOrder).toEqual(['tab-w2'])
    expect(s.sessionsGridHiddenTabIds).toEqual(['tab-w2'])
  })

  it('leaves both session-grid lists by reference when the removed project owned no listed tab', async () => {
    const store = createTestStore()
    seedTwoProjects(store)
    const order = ['tab-w2']
    const hidden = ['tab-w2']
    store.setState({ sessionsGridTabOrder: order, sessionsGridHiddenTabIds: hidden })

    await store.getState().removeProject(repo1.id)

    // An unrelated removal must not read as a persisted-UI edit and schedule a write.
    const s = store.getState()
    expect(s.sessionsGridTabOrder).toBe(order)
    expect(s.sessionsGridHiddenTabIds).toBe(hidden)
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
    expect(s.localDetectedAgentIdsByContext['repo-2:windows-host']).toEqual(['codex'])
    expect(s.sessionsGridTabOrder).toEqual(['tab-w2'])
    expect(s.sessionsGridHiddenTabIds).toEqual(['tab-w2'])
  })
})
