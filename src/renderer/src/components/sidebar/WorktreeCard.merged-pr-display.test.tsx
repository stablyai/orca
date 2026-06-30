import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GlobalSettings,
  PRInfo,
  Repo,
  Worktree,
  WorktreeCardProperty
} from '../../../../shared/types'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = ['pr']
let hostedReviewCache: Record<string, unknown> = {}
let prCache: Record<string, unknown> = {}
let settings: Partial<GlobalSettings> | null = null

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
      prCache,
      projectGroups: [],
      remoteBranchConflictByWorktreeId: {},
      settings,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      updateWorktreeMeta,
      workspacePortScan: null,
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
  useWorktreeActivityStatus: () => 'active'
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
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

function makePRInfo(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 6340,
    title: 'Merged PR still checked out',
    state: 'merged',
    url: 'https://github.com/acme/orca/pull/6340',
    checksStatus: 'success',
    updatedAt: '2026-05-17T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    headSha: 'abc123',
    ...overrides
  }
}

function renderWorktreeCardMarkup(element: ReactNode): string {
  return renderToStaticMarkup(<>{element}</>)
}

describe('WorktreeCard merged PR fallback display', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: false }
    worktreeCardProperties = ['pr']
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: null,
        fetchedAt: 200
      }
    }
    prCache = {}
  })

  it('shows cached merged PR when a newer hosted-review miss still matches the worktree head', async () => {
    prCache = {
      'repo-1::feature/local-branch': {
        data: makePRInfo(),
        fetchedAt: 100
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({ linkedPR: null, head: 'abc123' })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('Linked PR #6340')
    expect(markup).not.toContain('Branch')
  })

  it('suppresses cached merged PR after a newer hosted-review miss when the worktree head moved', async () => {
    prCache = {
      'repo-1::feature/local-branch': {
        data: makePRInfo({
          title: 'Merged PR no longer checked out',
          headSha: 'old-head'
        }),
        fetchedAt: 100
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({ linkedPR: null, head: 'new-head' })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).not.toContain('Linked PR #6340')
    expect(markup).not.toContain('Merged PR no longer checked out')
  })
})
