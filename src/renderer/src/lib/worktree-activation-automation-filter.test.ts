import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/types'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function makeAutomationWorktree(): Worktree {
  return {
    id: 'repo-1::/workspace/automation-run',
    repoId: 'repo-1',
    path: '/workspace/automation-run',
    head: 'abc123',
    branch: 'refs/heads/automation-run',
    isBare: false,
    isMainWorktree: false,
    displayName: 'automation-run',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    automationProvenance: {
      kind: 'created-by-automation',
      automationId: 'automation-1',
      automationNameSnapshot: 'Nightly review',
      automationRunId: 'run-1',
      automationRunTitleSnapshot: 'Nightly review run',
      createdAt: 123,
      executionTargetType: 'local',
      executionTargetId: 'local',
      projectId: 'repo-1',
      repoId: 'repo-1',
      hostId: 'local'
    }
  }
}

describe('activateAndRevealWorktree automation filters', () => {
  it('clears the automation-generated filter before revealing an automation-created worktree', () => {
    const worktree = makeAutomationWorktree()
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
      hideAutomationGeneratedWorkspaces: true,
      markWorktreeVisited: vi.fn(),
      recordWorktreeVisit: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn(),
      revealWorktreeInSidebar
    })

    activateAndRevealWorktree(worktree.id)

    expect(useAppStore.getState().hideAutomationGeneratedWorkspaces).toBe(false)
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith(worktree.id)
  })
})
