import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree, WorktreeCardProperty } from '../../../../shared/types'
import type WorktreeCardComponent from './WorktreeCard'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = ['status', 'unread']
let tabsByWorktree: Record<string, { id: string }[]> = {}
let ptyIdsByTabId: Record<string, string[]> = {}
let browserTabsByWorktree: Record<string, { id: string }[]> = {}
let WorktreeCard: typeof WorktreeCardComponent

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
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope',
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu'
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
  beforeAll(async () => {
    WorktreeCard = (await import('./WorktreeCard')).default
  }, 20_000)

  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = ['status', 'unread']
    tabsByWorktree = {}
    ptyIdsByTabId = {}
    browserTabsByWorktree = {}
  })

  it('marks the unread toggle as a workspace-board-preserving action', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('aria-label="Mark as read"')
    expect(markup).toContain('data-workspace-board-preserve-open=""')
  })

  it('shows delete as the top-right quick action for an inactive workspace', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('aria-label="Delete workspace"')
  })

  it('shows delete as the quick action for inactive folder workspace instances', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          id: 'repo-1::/repo::workspace:123e4567-e89b-12d3-a456-426614174000',
          path: '/repo',
          isMainWorktree: false
        })}
        repo={{ ...makeRepo(), kind: 'folder' }}
        isActive={false}
      />
    )

    expect(markup).toContain('aria-label="Delete workspace"')
  })

  it('does not replace sleep with delete for a workspace with live activity', () => {
    const worktree = makeWorktree()
    tabsByWorktree = { [worktree.id]: [{ id: 'tab-1' }] }
    ptyIdsByTabId = { 'tab-1': ['pty-1'] }

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} />
    )

    expect(markup).not.toContain('aria-label="Sleep workspace"')
    expect(markup).not.toContain('aria-label="Delete workspace"')
  })

  it('does not show sleep as the top-right quick action for an active workspace', () => {
    const worktree = makeWorktree()
    tabsByWorktree = { [worktree.id]: [{ id: 'tab-1' }] }
    ptyIdsByTabId = { 'tab-1': ['pty-1'] }

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive />
    )

    expect(markup).not.toContain('aria-label="Sleep workspace"')
    expect(markup).not.toContain('aria-label="Delete workspace"')
  })

  it('does not show delete when the workspace is current but not selected in the sidebar', () => {
    const worktree = makeWorktree()

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} isCurrentWorktree />
    )

    expect(markup).not.toContain('aria-label="Delete workspace"')
  })
})
