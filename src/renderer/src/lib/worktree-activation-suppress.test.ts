import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/types'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function makeWorktree(): Worktree {
  return {
    id: 'repo-1::/workspace/orcastrator',
    repoId: 'repo-1',
    path: '/workspace/orcastrator',
    head: 'abc123',
    branch: 'refs/heads/orcastrator',
    isBare: false,
    isMainWorktree: false,
    displayName: 'orcastrator',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function seedStore(worktree: Worktree, overrides: Record<string, unknown>): void {
  useAppStore.setState({
    repos: [
      {
        id: worktree.repoId,
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0
      }
    ],
    worktreesByRepo: { [worktree.repoId]: [worktree] },
    // Why: a DIFFERENT worktree is active so a real activation would visibly
    // switch the user's tab — that switch is what suppression must prevent.
    activeRepoId: worktree.repoId,
    activeView: 'terminal',
    activeWorktreeId: 'repo-1::/workspace/other',
    activeTabId: 'tab-other',
    activeTabType: 'terminal',
    // Why: a non-empty renderable model so activation skips creating an initial
    // terminal — the test asserts on activation/reveal, not terminal seeding.
    tabsByWorktree: { [worktree.id]: [] },
    ptyIdsByTabId: {},
    everActivatedWorktreeIds: new Set([worktree.id]),
    setActiveWorktree: vi.fn(),
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    reconcileWorktreeTabModel: vi.fn(() => ({
      renderableTabCount: 1,
      activeRenderableTabId: null
    })),
    ...overrides
  })
}

describe('activateAndRevealWorktree suppressActivation', () => {
  it('reveals in the sidebar but does NOT switch the active worktree when suppressed', () => {
    const worktree = makeWorktree()
    const setActiveWorktree = vi.fn()
    const revealWorktreeInSidebar = vi.fn()
    seedStore(worktree, { setActiveWorktree, revealWorktreeInSidebar })

    const result = activateAndRevealWorktree(worktree.id, { suppressActivation: true })

    expect(result).not.toBe(false)
    // The reveal (sidebar tree + Mission Control DAG) still happens...
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith(worktree.id)
    // ...but the user's active tab is NOT yanked to the new worktree.
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeWorktreeId).toBe('repo-1::/workspace/other')
  })

  it('switches the active worktree (default behavior) when not suppressed', () => {
    const worktree = makeWorktree()
    const setActiveWorktree = vi.fn()
    const revealWorktreeInSidebar = vi.fn()
    seedStore(worktree, { setActiveWorktree, revealWorktreeInSidebar })

    const result = activateAndRevealWorktree(worktree.id)

    expect(result).not.toBe(false)
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith(worktree.id)
    expect(setActiveWorktree).toHaveBeenCalledWith(worktree.id)
  })
})
