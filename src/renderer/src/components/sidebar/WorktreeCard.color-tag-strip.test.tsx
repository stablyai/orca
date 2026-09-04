import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

const WORKTREE_CARD_IMPORT_TIMEOUT_MS = 15_000

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch: vi.fn(),
      fetchIssue: vi.fn(),
      fetchLinearIssue: vi.fn(),
      gitConflictOperationByWorktree: {},
      hostedReviewCache: {},
      issueCache: {},
      linearIssueCache: {},
      openModal: vi.fn(),
      projectGroups: [],
      remoteBranchConflictByWorktreeId: {},
      settings: null,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      updateWorktreeMeta: vi.fn(),
      workspacePortScan: null,
      worktreeCardProperties: []
    })
}))

vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./use-worktree-activity-status', () => ({ useWorktreeActivityStatus: () => 'idle' }))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('./WorktreeCardAgents', () => ({ default: () => null }))

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
  } as Repo
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/a',
    repoId: 'repo-1',
    path: '/repo/worktrees/a',
    displayName: 'Auth work',
    branch: 'feature/auth',
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
  } as Worktree
}

describe('WorktreeCard color tag strip', () => {
  beforeEach(() => vi.clearAllMocks())

  it(
    'paints the grouping strip for a tagged workspace',
    async () => {
      const { default: WorktreeCard } = await import('./WorktreeCard')
      const markup = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree({ colorTag: '#ef4444' })}
          repo={makeRepo()}
          isActive={false}
        />
      )

      expect(markup).toContain('data-worktree-card-color-tag="#ef4444"')
      expect(markup).toContain('background-color:#ef4444')
      // Why: the strip is aria-hidden, so the card's text must carry the tag for assistive tech.
      expect(markup).toContain('Color tag #ef4444')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'renders no strip when the workspace is untagged or the stored value is unusable',
    async () => {
      const { default: WorktreeCard } = await import('./WorktreeCard')

      for (const colorTag of [undefined, null, '', 'not-a-color']) {
        const markup = renderToStaticMarkup(
          <WorktreeCard worktree={makeWorktree({ colorTag })} repo={makeRepo()} isActive={false} />
        )
        expect(markup).not.toContain('data-worktree-card-color-tag')
        expect(markup).not.toContain('Color tag')
      }
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'normalizes a shorthand tag so the strip and the menu selection agree',
    async () => {
      const { default: WorktreeCard } = await import('./WorktreeCard')
      const markup = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree({ colorTag: '#F44' })}
          repo={makeRepo()}
          isActive={false}
        />
      )

      expect(markup).toContain('data-worktree-card-color-tag="#ff4444"')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )
})
