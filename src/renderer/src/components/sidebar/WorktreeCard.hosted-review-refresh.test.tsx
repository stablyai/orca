// @vitest-environment happy-dom
import { type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree, WorktreeCardProperty } from '../../../../shared/types'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = ['status']
let root: Root | null = null
let container: HTMLDivElement | null = null

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch,
      fetchIssue,
      fetchLinearIssue,
      gitConflictOperationByWorktree: {},
      hostedReviewCache: {
        'local::repo-1::feature/branch': {
          data: null,
          fetchedAt: Date.now(),
          linkedReviewHintKey: ''
        }
      },
      issueCache: {},
      linearIssueCache: {},
      openModal,
      projectGroups: [],
      remoteBranchConflictByWorktreeId: {},
      settings: { experimentalNewWorktreeCardStyle: true },
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      updateWorktreeMeta,
      workspacePortScan: null,
      worktreeCardProperties
    })
}))

vi.mock('@/lib/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
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

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'active'
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
    id: 'repo-1::/repo/worktrees/branch',
    repoId: 'repo-1',
    path: '/repo/worktrees/branch',
    displayName: 'feature/branch',
    branch: 'feature/branch',
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

describe('WorktreeCard hosted review refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    worktreeCardProperties = ['status']
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
    vi.useRealTimers()
  })

  it('polls visible hosted review cards after a cached branch miss', async () => {
    const { default: WorktreeCard } = await import('./WorktreeCard')

    act(() => {
      root?.render(<WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />)
    })

    expect(fetchHostedReviewForBranch).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(fetchHostedReviewForBranch).toHaveBeenCalledTimes(2)
    expect(fetchHostedReviewForBranch).toHaveBeenLastCalledWith('/repo', 'feature/branch', {
      repoId: 'repo-1',
      linkedGitHubPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null,
      staleWhileRevalidate: true
    })
  })

  it('does not poll hosted reviews when status and PR surfaces are hidden', async () => {
    worktreeCardProperties = []
    const { default: WorktreeCard } = await import('./WorktreeCard')

    act(() => {
      root?.render(<WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />)
    })

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(fetchHostedReviewForBranch).not.toHaveBeenCalled()
  })
})
