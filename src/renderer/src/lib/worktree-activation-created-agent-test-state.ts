import path from 'node:path'
import { vi } from 'vitest'
import type { Worktree } from '../../../shared/types'
import { useAppStore } from '@/store'

export function makeCreatedAgentWorktree(): Worktree {
  const workspacePath = path.join(path.sep, 'workspace', 'feature')
  return {
    id: `repo-1::${workspacePath}`,
    repoId: 'repo-1',
    path: workspacePath,
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
    createdWithAgent: 'codex'
  }
}

export function seedAlreadyActiveWorktree(
  worktree: Worktree,
  overrides: Partial<ReturnType<typeof useAppStore.getState>> = {}
): {
  markWorktreeVisited: ReturnType<typeof vi.fn>
  recordWorktreeVisit: ReturnType<typeof vi.fn>
  revealWorktreeInSidebar: ReturnType<typeof vi.fn>
} {
  const markWorktreeVisited = vi.fn()
  const recordWorktreeVisit = vi.fn()
  const revealWorktreeInSidebar = vi.fn()
  const terminalTitle = ['Terminal', '1'].join(' ')
  const repoPath = path.join(path.sep, 'workspace', 'repo')

  useAppStore.setState({
    repos: [
      {
        id: worktree.repoId,
        path: repoPath,
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
    tabsByWorktree: {
      [worktree.id]: [
        {
          id: 'tab-1',
          ptyId: 'pty-1',
          worktreeId: worktree.id,
          title: terminalTitle,
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    unifiedTabsByWorktree: {
      [worktree.id]: [
        {
          id: 'tab-1',
          entityId: 'tab-1',
          groupId: 'group-1',
          worktreeId: worktree.id,
          contentType: 'terminal',
          label: terminalTitle,
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    groupsByWorktree: {
      [worktree.id]: [
        {
          id: 'group-1',
          worktreeId: worktree.id,
          activeTabId: 'tab-1',
          tabOrder: ['tab-1']
        }
      ]
    },
    activeGroupIdByWorktree: { [worktree.id]: 'group-1' },
    activeTabTypeByWorktree: { [worktree.id]: 'terminal' },
    everActivatedWorktreeIds: new Set([worktree.id]),
    openFiles: [],
    browserTabsByWorktree: {},
    activeFileIdByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    activeTabIdByWorktree: { [worktree.id]: 'tab-1' },
    tabBarOrderByWorktree: {},
    settings: {
      agentCmdOverrides: {},
      setupScriptLaunchMode: 'new-tab'
    } as unknown as ReturnType<typeof useAppStore.getState>['settings'],
    markWorktreeVisited,
    recordWorktreeVisit,
    refreshGitHubForWorktreeIfStale: vi.fn(),
    revealWorktreeInSidebar,
    ...overrides
  })

  return { markWorktreeVisited, recordWorktreeVisit, revealWorktreeInSidebar }
}
