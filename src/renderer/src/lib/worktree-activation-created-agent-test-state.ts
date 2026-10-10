import path from 'node:path'
import { vi } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
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

type StoreState = ReturnType<typeof useAppStore.getState>

/** The empty-workspace store shape both seeds start from; each layers its own tabs/actions on top. */
function baseSeedState(worktree: Worktree, worktrees: Worktree[]): Partial<StoreState> {
  return {
    repos: [
      {
        id: worktree.repoId,
        path: path.join(path.sep, 'workspace', 'repo'),
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0
      }
    ],
    worktreesByRepo: { [worktree.repoId]: worktrees },
    activeRepoId: worktree.repoId,
    activeView: 'terminal',
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    openFiles: [],
    browserTabsByWorktree: {},
    activeFileIdByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    activeTabTypeByWorktree: {},
    activeTabIdByWorktree: {},
    tabBarOrderByWorktree: {},
    pendingStartupByTabId: {},
    settings: {
      agentCmdOverrides: {},
      setupScriptLaunchMode: 'new-tab'
    } as unknown as StoreState['settings'],
    refreshGitHubForWorktreeIfStale: vi.fn()
  }
}

/** Seeds a `createdWithAgent` worktree with zero renderable tabs — the state that used to
 *  trigger the removed creation-agent relaunch. */
export function seedEmptyActivatableWorktree(
  worktree: Worktree,
  options: { extraWorktrees?: Worktree[] } = {}
): { revealWorktreeInSidebar: ReturnType<typeof vi.fn> } {
  const revealWorktreeInSidebar = vi.fn()

  useAppStore.setState({
    ...baseSeedState(worktree, [...(options.extraWorktrees ?? []), worktree]),
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    revealWorktreeInSidebar
  })

  // Why: orphan terminals and reconnectable PTYs also feed renderableTabCount, so
  // assert the premise — drift here would make the regression tests pass blind.
  const { renderableTabCount } = useAppStore.getState().reconcileWorktreeTabModel(worktree.id)
  if (renderableTabCount !== 0) {
    throw new Error(
      `seedEmptyActivatableWorktree: expected 0 renderable tabs, got ${renderableTabCount}`
    )
  }

  return { revealWorktreeInSidebar }
}

export function seedAlreadyActiveWorktree(
  worktree: Worktree,
  overrides: Partial<StoreState> = {}
): {
  markWorktreeVisited: ReturnType<typeof vi.fn>
  recordWorktreeVisit: ReturnType<typeof vi.fn>
  revealWorktreeInSidebar: ReturnType<typeof vi.fn>
} {
  const markWorktreeVisited = vi.fn()
  const recordWorktreeVisit = vi.fn()
  const revealWorktreeInSidebar = vi.fn()
  const terminalTitle = ['Terminal', '1'].join(' ')

  useAppStore.setState({
    ...baseSeedState(worktree, [worktree]),
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
    activeTabIdByWorktree: { [worktree.id]: 'tab-1' },
    markWorktreeVisited,
    recordWorktreeVisit,
    revealWorktreeInSidebar,
    ...overrides
  })

  return { markWorktreeVisited, recordWorktreeVisit, revealWorktreeInSidebar }
}
