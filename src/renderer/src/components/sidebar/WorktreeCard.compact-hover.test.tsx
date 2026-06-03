import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { GlobalSettings, Repo, Worktree, WorktreeCardProperty } from '../../../../shared/types'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const openTaskPage = vi.fn()
const updateWorktreeMeta = vi.fn()
const recordFeatureInteraction = vi.fn()
const setWorkspacePortScan = vi.fn()
const setWorkspacePortScanRefreshing = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = ['pr', 'ports']
let hostedReviewCache: Record<string, unknown> = {}
let workspacePortScan: { key: string; result: WorkspacePortScanResult } | null = null
let settings: Partial<GlobalSettings> | null = { experimentalCompactWorktreeCards: true }

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      browserTabsByWorktree: {},
      createBrowserTab: vi.fn(),
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch,
      fetchIssue,
      fetchLinearIssue,
      gitConflictOperationByWorktree: {},
      hostedReviewCache,
      issueCache: {},
      linearIssueCache: {},
      openModal,
      openTaskPage,
      ptyIdsByTabId: {},
      recordFeatureInteraction,
      remoteBranchConflictByWorktreeId: {},
      setRemoteBrowserPageHandle: vi.fn(),
      setWorkspacePortScan,
      setWorkspacePortScanRefreshing,
      settings,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      tabsByWorktree: {},
      updateWorktreeMeta,
      workspacePortScan,
      worktreeCardProperties
    })
}))

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children, openDelay }: { children: ReactNode; openDelay?: number }) => (
    <div data-hover-open-delay={openDelay}>{children}</div>
  ),
  HoverCardContent: ({ children }: { children: ReactNode }) => (
    <div data-hover-card-content="">{children}</div>
  ),
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/lib/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'idle'
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

describe('WorktreeCard compact hover details', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = ['pr', 'ports']
    hostedReviewCache = {}
    workspacePortScan = null
    settings = { experimentalCompactWorktreeCards: true }
  })

  it('shows PR and live port details from the compact worktree title hover', async () => {
    const worktree = makeWorktree({ linkedPR: 456 })
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: makeHostedReview(),
        fetchedAt: Date.now()
      }
    }
    workspacePortScan = {
      key: 'repo-1',
      result: {
        platform: 'darwin',
        scannedAt: 1,
        ports: [
          {
            id: '127.0.0.1:58941:1234',
            bindHost: '127.0.0.1',
            connectHost: '127.0.0.1',
            port: 58941,
            pid: 1234,
            processName: 'node',
            protocol: 'http',
            kind: 'workspace',
            owner: {
              worktreeId: worktree.id,
              repoId: worktree.repoId,
              displayName: worktree.displayName,
              path: worktree.path,
              confidence: 'cwd'
            }
          }
        ]
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('data-worktree-title-inline-rename=""')
    expect(markup).toContain('data-hover-open-delay="100"')
    expect(markup).toContain('PR #456')
    expect(markup).toContain('Fix stale GH PR')
    expect(markup).toContain('Live Ports')
    expect(markup).toContain('58941')
    expect(markup).not.toContain('data-worktree-card-meta-row=""')
  })
})
