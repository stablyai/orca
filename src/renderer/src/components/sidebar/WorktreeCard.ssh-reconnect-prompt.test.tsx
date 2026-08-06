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
let removedSshTargetLabels = new Map<string, string>()
let runtimeStatusByEnvironmentId = new Map<string, { status?: unknown }>()
let runtimeEnvironments: { id: string; name: string }[] = []
let sshStateByEnvironment = new Map()
let worktreesByRepo: Record<string, Worktree[]> = {}
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
    removedSshTargetLabels = new Map()
    runtimeStatusByEnvironmentId = new Map()
    runtimeEnvironments = []
    sshStateByEnvironment = new Map()
    worktreesByRepo = {}
    worktreeCardProperties = ['status']
  })

  // Supersedes the old "does not auto-open the blocking reconnect dialog" assertion:
  // the dialog is gone, so no card state can open one.
  it('offers an inline reconnect control and never a blocking dialog for a disconnected SSH worktree', () => {
    sshConnectionStates.set('ssh-target-1', { status: 'disconnected' })
    sshTargetLabels.set('ssh-target-1', 'Remote target')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={true} />
    )

    expect(markup).toContain('Connect to SSH host Remote target')
    expect(markup).toContain('Connect')
    expect(markup).not.toContain('ssh-disconnected-dialog')
    // Why: a card-root opacity composites the whole subtree, so it would dim the control's
    // destructive tint and spinner in the exact state the control exists for.
    expect(markup).not.toContain('opacity-60')
  })

  it('names the failure state in the control verb rather than a generic Connect', () => {
    sshConnectionStates.set('ssh-target-1', { status: 'auth-failed' })
    sshTargetLabels.set('ssh-target-1', 'Remote target')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('Reconnect SSH host Remote target')
    expect(markup).toContain('authentication failed')
  })

  it('renders the passive host glyph, not a control, when the SSH host is connected', () => {
    sshConnectionStates.set('ssh-target-1', { status: 'connected' })
    sshTargetLabels.set('ssh-target-1', 'Remote target')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('Project on SSH host Remote target')
    expect(markup).not.toContain('Connect to SSH host')
  })

  // Why: the control keys off repo.connectionId, which is orthogonal to workspace kind —
  // a folder workspace on a disconnected SSH host must get the same affordance.
  it('offers the control for a folder workspace on a disconnected SSH host', () => {
    sshConnectionStates.set('ssh-target-1', { status: 'error' })
    sshTargetLabels.set('ssh-target-1', 'Remote target')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree()}
        repo={{ ...makeRepo(), kind: 'folder' }}
        isActive={false}
      />
    )

    expect(markup).toContain('Retry SSH connection to Remote target')
  })

  // Why: ssh:listTargets filters runtime-owned targets out, so "absent from the target list"
  // is not evidence of removal — deriving targetRemoved from it would put every ephemeral-VM
  // workspace card into the dead "host removed" state.
  it('never reports a runtime-owned SSH target as removed', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree()}
        repo={{ ...makeRepo(), connectionId: 'runtime-ssh-abc123' }}
        isActive={false}
      />
    )

    expect(markup).not.toContain('was removed')
    expect(markup).toContain('Project on SSH host')
  })

  // Why: a removed host can never connect, so the card must not offer a Connect that only fails.
  it('reports a removed SSH host once the target list no longer carries it', () => {
    sshConnectionStates.set('ssh-target-1', { status: 'error' })
    removedSshTargetLabels.set('ssh-target-1', 'Remote target (removed)')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('was removed')
    expect(markup).not.toContain('Retry SSH connection')
  })

  it('marks a runtime-host worktree disconnected when its environment has no status', () => {
    runtimeEnvironments = [{ id: 'env-1', name: 'Remote Mac' }]
    const runtimeRepo: Repo = {
      ...makeRepo(),
      connectionId: undefined,
      executionHostId: 'runtime:env-1'
    }
    // No status entry for env-1 → host is disconnected.
    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={runtimeRepo} isActive={false} />
    )
    expect(markup).toContain('Remote Mac disconnected')
  })

  it('distinguishes connected worktrees on different Orca servers', () => {
    runtimeEnvironments = [
      { id: 'env-1', name: 'Remote Mac' },
      { id: 'env-2', name: 'Build Linux' }
    ]
    runtimeStatusByEnvironmentId.set('env-1', { status: { runtimeId: 'r1' } })
    runtimeStatusByEnvironmentId.set('env-2', { status: { runtimeId: 'r2' } })

    const remoteMacMarkup = renderToStaticMarkup(
      <WorktreeCard
        worktree={{ ...makeWorktree(), runtimeOwnerEnvironmentId: 'env-1' }}
        repo={{ ...makeRepo(), connectionId: undefined, executionHostId: 'runtime:env-2' }}
        isActive={false}
      />
    )
    const buildLinuxMarkup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree()}
        repo={{ ...makeRepo(), connectionId: undefined, executionHostId: 'runtime:env-2' }}
        isActive={false}
      />
    )

    expect(remoteMacMarkup).toContain('Project on Remote Mac')
    expect(buildLinuxMarkup).toContain('Project on Build Linux')
  })

  it('reads nested SSH readiness from the owning HUB instead of client-local SSH state', () => {
    runtimeStatusByEnvironmentId.set('hub-1', { status: { runtimeId: 'hub-runtime' } })
    sshConnectionStates.set('ssh-target-1', { status: 'disconnected' })
    sshTargetLabels.set('ssh-target-1', 'Misleading client-local target')
    sshStateByEnvironment.set('hub-1', {
      connectionStates: new Map([['ssh-target-1', { status: 'connected' }]]),
      targetLabels: new Map([['ssh-target-1', 'HUB private target']]),
      removedTargetLabels: new Map(),
      targetsHydrated: true
    })
    const worktree = {
      ...makeWorktree(),
      hostId: 'ssh:ssh-target-1' as const,
      runtimeOwnerEnvironmentId: 'hub-1'
    }
    worktreesByRepo = { 'repo-1': [worktree] }

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} />
    )

    expect(markup).not.toContain('SSH disconnected')
    expect(markup).toContain('data-ssh-target-label="HUB private target"')
    expect(markup).not.toContain('Misleading client-local target')
  })
})
