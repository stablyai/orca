import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import { cloneDefaultWorkspaceStatuses } from '../../../shared/workspace-statuses'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/workspace/feature',
    repoId: 'repo-1',
    path: '/workspace/feature',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function seedActiveWorktree(worktree: Worktree, extra: Record<string, unknown>): () => void {
  const revealWorktreeInSidebar = vi.fn()
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
    activeRepoId: worktree.repoId,
    activeView: 'terminal',
    activeWorktreeId: worktree.id,
    activeTabId: 'tab-1',
    activeTabType: 'terminal',
    tabsByWorktree: { [worktree.id]: [] },
    ptyIdsByTabId: {},
    everActivatedWorktreeIds: new Set([worktree.id]),
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    revealWorktreeInSidebar,
    ...extra
  })
  return () => expect(revealWorktreeInSidebar).toHaveBeenCalledWith(worktree.id)
}

describe('activateAndRevealWorktree workspace-status filter', () => {
  it('clears a status filter that would hide the revealed worktree', () => {
    // Unset status resolves to the catalog default (in-progress); filter is completed.
    const worktree = makeWorktree()
    const expectRevealed = seedActiveWorktree(worktree, {
      filterWorkspaceStatuses: ['completed']
    })

    activateAndRevealWorktree(worktree.id)

    expect(useAppStore.getState().filterWorkspaceStatuses).toEqual([])
    expectRevealed()
  })

  it('leaves the status filter intact when the target matches it', () => {
    const worktree = makeWorktree({ workspaceStatus: 'completed' })
    seedActiveWorktree(worktree, { filterWorkspaceStatuses: ['completed'] })

    activateAndRevealWorktree(worktree.id)

    expect(useAppStore.getState().filterWorkspaceStatuses).toEqual(['completed'])
  })
})
