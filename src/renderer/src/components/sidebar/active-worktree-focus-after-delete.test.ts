import { beforeEach, describe, expect, it, vi } from 'vitest'

type SeedWorktree = {
  id: string
  repoId: string
  isMainWorktree: boolean
  hostId?: string
}
type SeedRepo = { id: string; connectionId?: string | null; executionHostId?: string | null }

const mocks = vi.hoisted(() => {
  const state = {
    activeView: 'terminal',
    activePendingCreationId: null as string | null,
    activeWorktreeId: null as string | null,
    worktreesByRepo: {} as Record<string, SeedWorktree[]>,
    repos: [] as SeedRepo[],
    lastVisitedAtByWorktreeId: {} as Record<string, number>,
    deleteStateByWorktreeId: {} as Record<string, { isDeleting?: boolean }>,
    worktreeMap: new Map<string, SeedWorktree>()
  }
  return { state }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state
  }
}))

vi.mock('@/store/selectors', () => ({
  getWorktreeMapFromState: () => mocks.state.worktreeMap,
  getRepoMapFromState: () => new Map(mocks.state.repos.map((repo) => [repo.id, repo]))
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { prepareActiveWorktreeFocusAfterDelete } from './active-worktree-focus-after-delete'

function seed(
  worktrees: { id: string; repoId?: string; isMainWorktree?: boolean; hostId?: string }[]
): void {
  const normalized: SeedWorktree[] = worktrees.map((worktree) => ({
    id: worktree.id,
    repoId: worktree.repoId ?? 'repo-1',
    isMainWorktree: worktree.isMainWorktree ?? false,
    ...(worktree.hostId ? { hostId: worktree.hostId } : {})
  }))
  mocks.state.worktreeMap = new Map(normalized.map((worktree) => [worktree.id, worktree]))
  const byRepo: Record<string, SeedWorktree[]> = {}
  for (const worktree of normalized) {
    ;(byRepo[worktree.repoId] ??= []).push(worktree)
  }
  mocks.state.worktreesByRepo = byRepo
  // A repo per referenced repoId so getRepoMapFromState resolves (host info comes via worktree.hostId).
  mocks.state.repos = [...new Set(normalized.map((w) => w.repoId))].map((id) => ({ id }))
}

// Why: mirror the store reducer — once a delete resolves, the removed worktree
// is gone from the worktree map and worktreesByRepo, its lastVisited entry is
// cleared, and activeWorktreeId is nulled only when it was the deleted worktree.
function simulateDelete(worktreeId: string, nulledActive: boolean): void {
  mocks.state.worktreeMap.delete(worktreeId)
  for (const repoId of Object.keys(mocks.state.worktreesByRepo)) {
    mocks.state.worktreesByRepo[repoId] = mocks.state.worktreesByRepo[repoId].filter(
      (worktree) => worktree.id !== worktreeId
    )
  }
  delete mocks.state.lastVisitedAtByWorktreeId[worktreeId]
  if (nulledActive) {
    mocks.state.activeWorktreeId = null
  }
}

describe('prepareActiveWorktreeFocusAfterDelete', () => {
  beforeEach(() => {
    mocks.state.activeView = 'terminal'
    mocks.state.activePendingCreationId = null
    mocks.state.activeWorktreeId = null
    mocks.state.worktreesByRepo = {}
    mocks.state.repos = []
    mocks.state.lastVisitedAtByWorktreeId = {}
    mocks.state.deleteStateByWorktreeId = {}
    mocks.state.worktreeMap = new Map()
    vi.mocked(activateAndRevealWorktree).mockClear()
  })

  it('focuses the most-recently-visited non-base sibling of the same project', () => {
    seed([{ id: 'main', isMainWorktree: true }, { id: 'wt-a' }, { id: 'wt-b' }, { id: 'wt-del' }])
    mocks.state.activeWorktreeId = 'wt-del'
    mocks.state.lastVisitedAtByWorktreeId = { 'wt-a': 100, 'wt-b': 200 }

    const commit = prepareActiveWorktreeFocusAfterDelete('wt-del')
    simulateDelete('wt-del', true)
    commit()

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-b')
  })

  it('falls back to the base/primary worktree when no other workspace remains', () => {
    seed([{ id: 'main', isMainWorktree: true }, { id: 'wt-del' }])
    mocks.state.activeWorktreeId = 'wt-del'

    const commit = prepareActiveWorktreeFocusAfterDelete('wt-del')
    simulateDelete('wt-del', true)
    commit()

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('main')
  })

  it('does not re-focus a sibling hosted on a torn-down runtime-owned SSH target', () => {
    // The runtime's main worktree is hosted on the per-workspace-env SSH target, which is
    // destroyed on delete — re-focusing it would create a blank terminal that can never spawn.
    seed([
      { id: 'main', isMainWorktree: true, hostId: 'ssh:runtime-ssh-orca-1' },
      { id: 'wt-del', hostId: 'ssh:runtime-ssh-orca-1' }
    ])
    mocks.state.activeWorktreeId = 'wt-del'

    const commit = prepareActiveWorktreeFocusAfterDelete('wt-del')
    simulateDelete('wt-del', true)
    commit()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('stays within the deleted worktree project instead of jumping to another project', () => {
    seed([
      { id: 'main-1', repoId: 'repo-1', isMainWorktree: true },
      { id: 'wt-del', repoId: 'repo-1' },
      { id: 'wt-other', repoId: 'repo-2' },
      { id: 'main-2', repoId: 'repo-2', isMainWorktree: true }
    ])
    mocks.state.activeWorktreeId = 'wt-del'

    const commit = prepareActiveWorktreeFocusAfterDelete('wt-del')
    simulateDelete('wt-del', true)
    commit()

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('main-1')
  })

  it('does not steal focus when the deleted worktree was not the active one', () => {
    seed([{ id: 'main', isMainWorktree: true }, { id: 'wt-active' }, { id: 'wt-del' }])
    mocks.state.activeWorktreeId = 'wt-active'

    const commit = prepareActiveWorktreeFocusAfterDelete('wt-del')
    simulateDelete('wt-del', false)
    commit()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not reclaim focus when the user navigated away during the delete', () => {
    seed([{ id: 'main', isMainWorktree: true }, { id: 'wt-a' }, { id: 'wt-del' }])
    mocks.state.activeWorktreeId = 'wt-del'

    const commit = prepareActiveWorktreeFocusAfterDelete('wt-del')
    simulateDelete('wt-del', false)
    // Why: a concurrent activation moved focus before the delete settled.
    mocks.state.activeWorktreeId = 'wt-a'
    commit()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not steal focus when the delete starts from a non-terminal view', () => {
    seed([{ id: 'main', isMainWorktree: true }, { id: 'wt-del' }])
    // Why: top-level views can retain the last terminal worktree id without
    // meaning the user is currently looking at that workspace.
    mocks.state.activeView = 'space'
    mocks.state.activeWorktreeId = 'wt-del'

    const commit = prepareActiveWorktreeFocusAfterDelete('wt-del')
    simulateDelete('wt-del', true)
    commit()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not reclaim focus when the user leaves terminal view during the delete', () => {
    seed([{ id: 'main', isMainWorktree: true }, { id: 'wt-del' }])
    mocks.state.activeWorktreeId = 'wt-del'

    const commit = prepareActiveWorktreeFocusAfterDelete('wt-del')
    simulateDelete('wt-del', true)
    mocks.state.activeView = 'settings'
    commit()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not steal focus when a pending creation panel is active before delete', () => {
    seed([{ id: 'main', isMainWorktree: true }, { id: 'wt-del' }])
    // Why: pending creation keeps the prior worktree id while the creation
    // surface owns the content area, so it is not viewing the old workspace.
    mocks.state.activePendingCreationId = 'creation-1'
    mocks.state.activeWorktreeId = 'wt-del'

    const commit = prepareActiveWorktreeFocusAfterDelete('wt-del')
    simulateDelete('wt-del', true)
    commit()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not reclaim focus when pending creation opens during the delete', () => {
    seed([{ id: 'main', isMainWorktree: true }, { id: 'wt-del' }])
    mocks.state.activeWorktreeId = 'wt-del'

    const commit = prepareActiveWorktreeFocusAfterDelete('wt-del')
    simulateDelete('wt-del', true)
    mocks.state.activePendingCreationId = 'creation-1'
    commit()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('skips workspaces that are themselves mid-delete when picking a successor', () => {
    seed([{ id: 'main', isMainWorktree: true }, { id: 'wt-a' }, { id: 'wt-del' }])
    mocks.state.activeWorktreeId = 'wt-del'
    mocks.state.lastVisitedAtByWorktreeId = { 'wt-a': 50 }

    const commit = prepareActiveWorktreeFocusAfterDelete('wt-del')
    simulateDelete('wt-del', true)
    mocks.state.deleteStateByWorktreeId = { 'wt-a': { isDeleting: true } }
    commit()

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('main')
  })

  it('does not steal focus when a non-worktree workspace is active', () => {
    seed([{ id: 'main', isMainWorktree: true }, { id: 'wt-del' }])
    // Why: folder workspaces hold a non-worktree key in activeWorktreeId, so a
    // background worktree delete must never move the user off it.
    mocks.state.activeWorktreeId = 'folder:abc'

    const commit = prepareActiveWorktreeFocusAfterDelete('wt-del')
    simulateDelete('wt-del', false)
    commit()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
