import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Repo, Worktree, WorktreeCardProperty } from '../../../../shared/types'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = []
let settings: Partial<GlobalSettings> | null = null
const WORKTREE_CARD_IMPORT_TIMEOUT_MS = 15_000

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch,
      fetchIssue,
      fetchLinearIssue,
      gitConflictOperationByWorktree: {},
      hostedReviewCache: {},
      issueCache: {},
      linearIssueCache: {},
      openModal,
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
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu',
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope'
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#999999',
    repoIcon: { type: 'emoji', emoji: '🦊' },
    addedAt: 1,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/pinned',
    repoId: 'repo-1',
    path: '/repo/worktrees/pinned',
    displayName: 'Pinned tree',
    branch: 'feature/pinned',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: true,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

describe('WorktreeCard pinned repo icon', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = []
    settings = null
  })

  it(
    'shows the configured repo icon for pinned cards even when the repo badge is hidden',
    async () => {
      const { default: WorktreeCard } = await import('./WorktreeCard')

      const markup = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree()}
          repo={makeRepo()}
          isActive={false}
          inPinnedSection
          // grouped-by-repo hides the normal badge; the pinned icon must still show
          hideRepoBadge
        />
      )

      expect(markup).toContain('🦊')
      expect(markup).toContain('Project orca')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'does not render the leading pinned repo icon for non-pinned cards',
    async () => {
      const { default: WorktreeCard } = await import('./WorktreeCard')

      const markup = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree({ isPinned: false })}
          repo={makeRepo()}
          isActive={false}
        />
      )

      expect(markup).not.toContain('🦊')
      expect(markup).not.toContain('Project orca')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'uses the pinned-style repo icon in new card style instead of a metadata-row badge',
    async () => {
      settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: true }
      worktreeCardProperties = ['status']
      const { default: WorktreeCard } = await import('./WorktreeCard')

      const markup = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree({ isPinned: false })}
          repo={makeRepo()}
          isActive={false}
        />
      )

      expect(markup).toContain('🦊')
      expect(markup).toContain('Project orca')
      expect(markup).not.toContain('data-worktree-card-meta-row=""')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )
})
