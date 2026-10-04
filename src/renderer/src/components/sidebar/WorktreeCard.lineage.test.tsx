import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type * as LineageHiddenActivityModule from './worktree-lineage-hidden-activity'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = []
const WORKTREE_CARD_IMPORT_TIMEOUT_MS = 15_000
const noHiddenActivity = { permission: 0, failed: 0, working: 0, monitoring: 0, interrupted: 0 }
const useLineageHiddenActivity = vi.fn((_worktreeIds: readonly string[]) => noHiddenActivity)

vi.mock('./worktree-lineage-hidden-activity', async (importOriginal) => ({
  ...(await importOriginal<typeof LineageHiddenActivityModule>()),
  useLineageHiddenActivity: (worktreeIds: readonly string[]) =>
    useLineageHiddenActivity(worktreeIds)
}))

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
      settings: null,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      updateWorktreeMeta,
      worktreeCardProperties
    })
}))

vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => null
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
    id: 'repo-1::/repo/worktrees/child',
    repoId: 'repo-1',
    path: '/repo/worktrees/child',
    displayName: 'Child workspace',
    branch: 'child-workspace',
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

describe('WorktreeCard lineage indicators', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = []
    useLineageHiddenActivity.mockImplementation(() => noHiddenActivity)
  })

  it(
    'does not render parent lineage badge copy on workspace cards',
    async () => {
      const { default: WorktreeCard } = await import('./WorktreeCard')

      const markup = renderToStaticMarkup(
        <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
      )

      expect(markup).not.toContain('Parent workspace')
      expect(markup).not.toContain('parent:')
      expect(markup).not.toContain('from master')
      expect(markup).not.toContain('Missing parent')
      expect(markup).toContain('overflow-hidden')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'keeps the child workspace toggle chip',
    async () => {
      const { default: WorktreeCard } = await import('./WorktreeCard')

      const markup = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree()}
          repo={makeRepo()}
          isActive={false}
          lineageChildCount={1}
          lineageCollapsed={false}
          onLineageToggle={vi.fn()}
        />
      )

      expect(markup).toContain('aria-label="Hide 1 child workspace"')
      expect(markup).toContain('1 child')
      expect(markup).not.toContain('Parent workspace')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'shows hidden descendant work on the collapsed child chip',
    async () => {
      useLineageHiddenActivity.mockImplementation(() => ({ ...noHiddenActivity, working: 2 }))
      const { default: WorktreeCard } = await import('./WorktreeCard')

      const markup = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree()}
          repo={makeRepo()}
          isActive={false}
          lineageChildCount={1}
          lineageCollapsed
          lineageHiddenDescendants={{ worktreeIds: ['child', 'grandchild'], unreadCount: 0 }}
          onLineageToggle={vi.fn()}
        />
      )

      expect(useLineageHiddenActivity).toHaveBeenCalledWith(['child', 'grandchild'])
      expect(markup).toContain('aria-label="Show 1 child workspace"')
      expect(markup).toContain('aria-describedby=')
      expect(markup).toContain('data-agent-spinner')
      expect(markup).not.toContain('lucide-workflow')
      expect(markup).toContain('2 working')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'puts a hidden permission request ahead of hidden work',
    async () => {
      useLineageHiddenActivity.mockImplementation(() => ({
        ...noHiddenActivity,
        permission: 1,
        working: 1
      }))
      const { default: WorktreeCard } = await import('./WorktreeCard')

      const markup = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree()}
          repo={makeRepo()}
          isActive={false}
          lineageChildCount={2}
          lineageCollapsed
          lineageHiddenDescendants={{ worktreeIds: ['child-a', 'child-b'], unreadCount: 0 }}
          onLineageToggle={vi.fn()}
        />
      )

      expect(markup).toContain('lucide-message-circle-question')
      expect(markup).not.toContain('data-agent-spinner')
      expect(markup).toContain('1 waiting for permission · 1 working')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'keeps the plain chip when hidden children are idle or the lineage is expanded',
    async () => {
      const { default: WorktreeCard } = await import('./WorktreeCard')

      const collapsedIdle = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree()}
          repo={makeRepo()}
          isActive={false}
          lineageChildCount={1}
          lineageCollapsed
          lineageHiddenDescendants={{ worktreeIds: ['child'], unreadCount: 0 }}
          onLineageToggle={vi.fn()}
        />
      )
      expect(collapsedIdle).toContain('lucide-workflow')
      expect(collapsedIdle).not.toContain('data-agent-spinner')
      expect(collapsedIdle).not.toContain('data-lineage-hidden-unread')

      useLineageHiddenActivity.mockClear()
      const expanded = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree()}
          repo={makeRepo()}
          isActive={false}
          lineageChildCount={1}
          lineageCollapsed={false}
          onLineageToggle={vi.fn()}
        />
      )
      expect(useLineageHiddenActivity).not.toHaveBeenCalled()
      expect(expanded).toContain('lucide-workflow')
      expect(expanded).not.toContain('aria-describedby=')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'shows a hidden failure on the collapsed child chip instead of the plain icon',
    async () => {
      useLineageHiddenActivity.mockImplementation(() => ({ ...noHiddenActivity, failed: 1 }))
      const { default: WorktreeCard } = await import('./WorktreeCard')

      const markup = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree()}
          repo={makeRepo()}
          isActive={false}
          lineageChildCount={1}
          lineageCollapsed
          lineageHiddenDescendants={{ worktreeIds: ['child'], unreadCount: 0 }}
          onLineageToggle={vi.fn()}
        />
      )

      expect(markup).not.toContain('lucide-workflow')
      expect(markup).toContain('bg-red-500')
      expect(markup).toContain('1 failed')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'badges the collapsed child chip when a hidden child finished unread',
    async () => {
      const { default: WorktreeCard } = await import('./WorktreeCard')

      const markup = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree()}
          repo={makeRepo()}
          isActive={false}
          lineageChildCount={1}
          lineageCollapsed
          lineageHiddenDescendants={{ worktreeIds: ['child'], unreadCount: 1 }}
          onLineageToggle={vi.fn()}
        />
      )

      expect(markup).toContain('lucide-workflow')
      expect(markup).toContain('data-lineage-hidden-unread')
      expect(markup).toContain('1 unread')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )
})
