import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree, WorktreeCardProperty } from '../../../../shared/types'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = ['status', 'unread']
let tabsByWorktree: Record<string, { id: string }[]> = {}
let ptyIdsByTabId: Record<string, string[]> = {}
let browserTabsByWorktree: Record<string, { id: string }[]> = {}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch,
      fetchIssue,
      gitConflictOperationByWorktree: {},
      hostedReviewCache: {},
      issueCache: {},
      openModal,
      remoteBranchConflictByWorktreeId: {},
      settings: null,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      browserTabsByWorktree,
      ptyIdsByTabId,
      tabsByWorktree,
      updateWorktreeMeta,
      worktreeCardProperties
    })
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'idle'
}))

vi.mock('./CacheTimer', () => ({
  default: () => null
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => null
}))

vi.mock('./SshDisconnectedDialog', () => ({
  SshDisconnectedDialog: () => null
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'orca:test-close-context-menus',
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope'
}))

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#999999',
    addedAt: 1
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/quick-action',
    repoId: 'repo-1',
    path: '/repo/worktrees/quick-action',
    displayName: 'Quick action',
    branch: 'quick-action',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: true,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

describe('WorktreeCard quick actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = ['status', 'unread']
    tabsByWorktree = {}
    ptyIdsByTabId = {}
    browserTabsByWorktree = {}
  })

  it('marks the unread toggle as a workspace-board-preserving action', async () => {
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('aria-label="Mark as read"')
    expect(markup).toContain('data-workspace-board-preserve-open=""')
  })

  it('shows delete as the top-right quick action for an inactive workspace', async () => {
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('aria-label="Delete workspace"')
  })

  it('shows sleep as the top-right quick action for a workspace with live activity', async () => {
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const worktree = makeWorktree()
    tabsByWorktree = { [worktree.id]: [{ id: 'tab-1' }] }
    ptyIdsByTabId = { 'tab-1': ['pty-1'] }

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('aria-label="Sleep workspace"')
  })
})
