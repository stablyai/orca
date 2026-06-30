import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Repo, Worktree, WorktreeCardProperty } from '../../../../shared/types'
import type WorktreeCardComponent from './WorktreeCard'
import type * as WorkspaceDeleteQuickAction from './workspace-delete-quick-action'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = ['status']
let settings: Partial<GlobalSettings> | null = null
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
      projectGroups: [],
      remoteBranchConflictByWorktreeId: {},
      settings,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      browserTabsByWorktree: {},
      ptyIdsByTabId: {},
      tabsByWorktree: {},
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

vi.mock('./workspace-delete-quick-action', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceDeleteQuickAction>()
  return {
    ...actual,
    useWorkspaceDeleteModifierPressed: () => false
  }
})

const PROJECT_PREFIX_ATTR = 'data-worktree-card-project-prefix='
const STATUS_SLOT_ATTR = 'data-worktree-card-status-slot='

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
    id: 'repo-1::/repo/worktrees/feature',
    repoId: 'repo-1',
    path: '/repo/worktrees/feature',
    displayName: 'hawksbill',
    branch: 'hawksbill',
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

describe('WorktreeCard project identity (header-less views)', () => {
  beforeAll(async () => {
    WorktreeCard = (await import('./WorktreeCard')).default
  }, 20_000)

  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = ['status']
    settings = null
  })

  it('prefixes the project name and keeps the status lane on a worktree row', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    // Why: the project prefix makes the row identifiable without a project header.
    expect(markup).toContain(PROJECT_PREFIX_ATTR)
    // A worktree keeps its branch-glyph status lane.
    expect(markup).toContain(STATUS_SLOT_ATTR)
  })

  it('drops the status lane for the primary worktree so it reads as a different level', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          id: 'repo-1::/repo',
          path: '/repo',
          displayName: 'main',
          branch: 'main',
          isMainWorktree: true
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain(PROJECT_PREFIX_ATTR)
    // Primary worktree omits the status lane entirely so it sits flush-left.
    expect(markup).not.toContain(STATUS_SLOT_ATTR)
  })

  it('does not prefix the project in the grouped Project view, and keeps the primary status lane', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          id: 'repo-1::/repo',
          path: '/repo',
          displayName: 'main',
          branch: 'main',
          isMainWorktree: true
        })}
        repo={makeRepo()}
        isActive={false}
        // hideRepoBadge is set by the list only when grouped by project (a header
        // already names the project), so the prefix and lane-omission turn off.
        hideRepoBadge
      />
    )

    expect(markup).not.toContain(PROJECT_PREFIX_ATTR)
    expect(markup).toContain(STATUS_SLOT_ATTR)
  })
})
