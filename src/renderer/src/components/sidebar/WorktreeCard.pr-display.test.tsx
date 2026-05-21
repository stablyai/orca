import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { Repo, Worktree, WorktreeCardProperty } from '../../../../shared/types'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = ['pr']
let hostedReviewCache: Record<string, unknown> = {}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch,
      fetchIssue,
      fetchLinearIssue,
      gitConflictOperationByWorktree: {},
      hostedReviewCache,
      issueCache: {},
      linearIssueCache: {},
      openModal,
      remoteBranchConflictByWorktreeId: {},
      settings: null,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
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
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu',
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
    id: 'repo-1::/repo/worktrees/pr-456',
    repoId: 'repo-1',
    path: '/repo/worktrees/pr-456',
    displayName: 'Fix stale GH PR',
    branch: 'feature/local-branch',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

function makeHostedReview(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 456,
    title: 'Fix stale GH PR',
    state: 'open',
    url: 'https://github.com/acme/orca/pull/456',
    status: 'success',
    updatedAt: '2026-05-17T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

function renderWorktreeCardMarkup(element: ReactNode): string {
  return renderToStaticMarkup(<>{element}</>)
}

describe('WorktreeCard linked PR display', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = ['pr']
    hostedReviewCache = {}
  })

  it('keeps an icon-only linked GH PR badge visible before hosted review details are cached', async () => {
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard worktree={makeWorktree({ linkedPR: 456 })} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('Linked PR #456')
    expect(markup).not.toContain('Loading PR')
  })

  it('renders issue, Linear issue, PR, and notes as icon-only metadata in the closed card', async () => {
    worktreeCardProperties = ['issue', 'pr', 'comment']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          linkedIssue: 123,
          linkedLinearIssue: 'ENG-123',
          linkedPR: 456,
          comment: 'Reviewer handoff note'
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('Linked issue #123')
    expect(markup).toContain('Linked Linear ENG-123')
    expect(markup).toContain('Linked PR #456')
    expect(markup).toContain('Workspace notes')
    expect(markup).not.toContain('data-slot="badge"')
    expect(markup).not.toContain('Loading issue')
    expect(markup).not.toContain('Loading PR')
    expect(markup).not.toContain('Reviewer handoff note')
    expect(markup.indexOf('Workspace notes')).toBeLessThan(markup.indexOf('Linked issue #123'))
  })

  it('does not render the standalone CI badge and colors a failing linked PR icon red', async () => {
    worktreeCardProperties = ['pr', 'ci']
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: makeHostedReview({ status: 'failure' }),
        fetchedAt: Date.now()
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard worktree={makeWorktree({ linkedPR: 456 })} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('Linked PR #456')
    expect(markup).toContain('text-rose-500/85')
    expect(markup).not.toContain('CI checks')
  })
})
