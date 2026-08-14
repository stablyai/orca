import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

let gitStatusByWorktree: Record<string, unknown[]> = {}
let settings: Record<string, unknown> | null = null
const WORKTREE_CARD_IMPORT_TIMEOUT_MS = 15_000

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch: vi.fn(),
      fetchIssue: vi.fn(),
      fetchLinearIssue: vi.fn(),
      gitConflictOperationByWorktree: {},
      gitStatusByWorktree,
      hostedReviewCache: {},
      issueCache: {},
      linearIssueCache: {},
      openModal: vi.fn(),
      projectGroups: [],
      remoteBranchConflictByWorktreeId: {},
      settings,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      updateWorktreeMeta: vi.fn(),
      worktreeCardProperties: []
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

const WORKTREE_ID = 'repo-1::/repo'

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#999999',
    addedAt: 1
  }
}

// Why: a plain main workspace with no issue, review, comment or port — the shape
// that silently lost its badge because the trailing cluster was gated on those.
function makeBareWorktree(): Worktree {
  return {
    id: WORKTREE_ID,
    repoId: 'repo-1',
    path: '/repo',
    displayName: 'main',
    branch: 'main',
    head: 'abc123',
    isBare: false,
    isMainWorktree: true,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
}

async function renderCard(): Promise<string> {
  const { default: WorktreeCard } = await import('./WorktreeCard')
  return renderToStaticMarkup(
    <WorktreeCard worktree={makeBareWorktree()} repo={makeRepo()} isActive={false} />
  )
}

describe('WorktreeCard change count', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gitStatusByWorktree = {}
    settings = null
  })

  it(
    'shows the count on a workspace carrying no other metadata',
    async () => {
      gitStatusByWorktree = { [WORKTREE_ID]: [{}, {}] }

      const markup = await renderCard()

      expect(markup).toContain('data-worktree-change-count')
      expect(markup).toContain('2 uncommitted changes')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'stays quiet when the workspace is clean',
    async () => {
      gitStatusByWorktree = { [WORKTREE_ID]: [] }

      const markup = await renderCard()

      expect(markup).not.toContain('data-worktree-change-count')
      expect(markup).not.toContain('uncommitted')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it.each([
    ['compact cards', { compactWorktreeCards: true }],
    ['the new card style', { experimentalNewWorktreeCardStyle: true }]
  ])(
    'shows the count on a bare workspace with %s',
    async (_label, cardSettings) => {
      // Why both: the trailing-cluster gate exists three times, one per card
      // style, and only the default style was covered. Reverting either of the
      // other two left the suite green while those users lost the badge.
      settings = cardSettings
      gitStatusByWorktree = { [WORKTREE_ID]: [{}, {}] }

      const markup = await renderCard()

      expect(markup).toContain('data-worktree-change-count')
      expect(markup).toContain('>2<')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )
})
