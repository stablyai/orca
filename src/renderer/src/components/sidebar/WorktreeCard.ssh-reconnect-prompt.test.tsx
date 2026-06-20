import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree, WorktreeCardProperty } from '../../../../shared/types'
import type WorktreeCardComponent from './WorktreeCard'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let WorktreeCard: typeof WorktreeCardComponent
let sshConnectionStates = new Map<string, { status: string }>()
let sshTargetLabels = new Map<string, string>()
let runtimeStatusByEnvironmentId = new Map<string, { status?: unknown }>()
let worktreeCardProperties: WorktreeCardProperty[] = ['status']

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
      remoteBranchConflictByWorktreeId: {},
      runtimeStatusByEnvironmentId,
      settings: null,
      sshConnectionStates,
      sshTargetLabels,
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

vi.mock('./SshDisconnectedDialog', () => ({
  SshDisconnectedDialog: ({
    open,
    status,
    targetLabel
  }: {
    open: boolean
    status: string
    targetLabel: string
  }) => (
    <div
      data-ssh-disconnected-dialog={open ? 'open' : 'closed'}
      data-ssh-status={status}
      data-ssh-target-label={targetLabel}
    />
  )
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
    displayName: 'Remote repo',
    badgeColor: '#999999',
    addedAt: 1,
    connectionId: 'ssh-target-1'
  }
}

function makeWorktree(): Worktree {
  return {
    id: 'worktree-1',
    repoId: 'repo-1',
    path: '/repo/worktrees/one',
    displayName: 'Remote workspace',
    branch: 'remote-workspace',
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
    lastActivityAt: 1
  }
}

describe('WorktreeCard SSH reconnect prompt', () => {
  beforeAll(async () => {
    WorktreeCard = (await import('./WorktreeCard')).default
  }, 20_000)

  beforeEach(() => {
    vi.clearAllMocks()
    sshConnectionStates = new Map()
    sshTargetLabels = new Map()
    runtimeStatusByEnvironmentId = new Map()
    worktreeCardProperties = ['status']
  })

  it('opens the reconnect dialog for an active disconnected SSH worktree during render', () => {
    sshConnectionStates.set('ssh-target-1', { status: 'disconnected' })
    sshTargetLabels.set('ssh-target-1', 'Remote target')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={true} />
    )

    expect(markup).toContain('data-ssh-disconnected-dialog="open"')
    expect(markup).toContain('data-ssh-status="disconnected"')
    expect(markup).toContain('data-ssh-target-label="Remote target"')
  })

  it('marks a runtime-host worktree disconnected when its environment has no status', () => {
    const runtimeRepo: Repo = {
      ...makeRepo(),
      connectionId: undefined,
      executionHostId: 'runtime:env-1'
    }
    // No status entry for env-1 → host is disconnected.
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={runtimeRepo} isActive={false} />
    )
    expect(markup).toContain('Server disconnected')
  })

  it('shows a runtime-host worktree as connected when its environment has a status', () => {
    runtimeStatusByEnvironmentId.set('env-1', { status: { runtimeId: 'r1' } })
    const runtimeRepo: Repo = {
      ...makeRepo(),
      connectionId: undefined,
      executionHostId: 'runtime:env-1'
    }
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={runtimeRepo} isActive={false} />
    )
    expect(markup).not.toContain('Server disconnected')
    expect(markup).toContain('Project on Orca server')
  })
})
