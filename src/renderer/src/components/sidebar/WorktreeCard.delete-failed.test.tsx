import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type WorktreeCardComponent from './WorktreeCard'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let WorktreeCard: typeof WorktreeCardComponent
let sshConnectionStates = new Map<string, { status: string }>()
let sshTargetLabels = new Map<string, string>()
let removedSshTargetLabels = new Map<string, string>()
let runtimeStatusByEnvironmentId = new Map<string, { status?: unknown }>()
let runtimeEnvironments: { id: string; name: string }[] = []
let sshStateByEnvironment = new Map()
let worktreesByRepo: Record<string, Worktree[]> = {}
let worktreeCardProperties: WorktreeCardProperty[] = ['status']
let deleteStateByWorktreeId: Record<string, { isDeleting: boolean; error: string | null }> = {}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      deleteStateByWorktreeId,
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
      runtimeEnvironments,
      runtimeStatusByEnvironmentId,
      removedSshTargetLabels,
      settings: null,
      sshConnectionStates,
      sshStateByEnvironment,
      sshTargetLabels,
      sshTargetsHydrated: true,
      updateWorktreeMeta,
      worktreesByRepo,
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

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => null
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'idle'
}))

vi.mock('./use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope',
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu'
}))

const FAILURE = "error: failed to delete '/repo/worktrees/one': Operation not permitted"

function makeRepo(): Repo {
  return { id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: '#999999', addedAt: 1 }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'worktree-1',
    repoId: 'repo-1',
    path: '/repo/worktrees/one',
    displayName: 'Workspace one',
    branch: 'one',
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

function renderCard(worktree: Worktree): string {
  // Static markup escapes the quotes in Git's message.
  return renderToStaticMarkup(
    <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} />
  ).replaceAll('&#x27;', "'")
}

describe('WorktreeCard for a delete that failed partway', () => {
  beforeAll(async () => {
    WorktreeCard = (await import('./WorktreeCard')).default
  }, 20_000)

  beforeEach(() => {
    vi.clearAllMocks()
    deleteStateByWorktreeId = {}
    worktreesByRepo = {}
    worktreeCardProperties = ['status']
  })

  it('says the delete failed, with the full error the host lists one hover away', () => {
    const markup = renderCard(makeWorktree({ removalError: FAILURE }))

    expect(markup).toContain('data-worktree-card-delete-failed')
    expect(markup).toContain('Delete failed')
    // The tooltip primitive is rendered inline by this harness.
    expect(markup).toContain(FAILURE)
  })

  it('shows nothing extra on a normal row', () => {
    const markup = renderCard(makeWorktree())

    expect(markup).not.toContain('data-worktree-card-delete-failed')
    expect(markup).not.toContain('Delete failed')
  })

  it('shows Deleting instead once the retry starts', () => {
    deleteStateByWorktreeId = { 'worktree-1': { isDeleting: true, error: null } }

    const markup = renderCard(makeWorktree({ removalError: FAILURE }))

    expect(markup).not.toContain('data-worktree-card-delete-failed')
    expect(markup).toContain('Deleting')
  })
})
