import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type {
  GlobalSettings,
  PRInfo,
  Repo,
  Worktree,
  WorktreeCardProperty
} from '../../../../shared/types'
import { COMPACT_WORKTREE_CARD_PROPERTIES } from '../../../../shared/worktree-card-properties'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = ['status']
let hostedReviewCache: Record<string, unknown> = {}
let issueCache: Record<string, unknown> = {}
let prCache: Record<string, unknown> = {}
let workspacePortScan: WorkspacePortScanResult | null = null
let settings: Partial<GlobalSettings> | null = null

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch,
      fetchIssue,
      fetchLinearIssue,
      gitConflictOperationByWorktree: {},
      hostedReviewCache,
      issueCache,
      linearIssueCache: {},
      openModal,
      prCache,
      projectGroups: [],
      remoteBranchConflictByWorktreeId: {},
      settings,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      updateWorktreeMeta,
      workspacePortScan,
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
  useWorktreeActivityStatus: () => 'active'
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

function makePRInfo(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 456,
    title: 'Fix stale GH PR',
    state: 'open',
    url: 'https://github.com/acme/orca/pull/456',
    checksStatus: 'success',
    updatedAt: '2026-05-17T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

function renderWorktreeCardMarkup(element: ReactNode): string {
  return renderToStaticMarkup(<>{element}</>)
}

function countAutomationCreatedLabels(markup: string): number {
  return markup.match(/Created by automation/g)?.length ?? 0
}

function getInlineRenameTitleTag(markup: string): string {
  const match = markup.match(/<span[^>]*data-worktree-title-inline-rename=""[^>]*>/)
  expect(match).not.toBeNull()
  return match?.[0] ?? ''
}

describe('WorktreeCard linked PR display', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = ['status']
    hostedReviewCache = {}
    issueCache = {}
    prCache = {}
    workspacePortScan = null
    settings = null
  })

  it('keeps linked GH PR status out of the left status slot by default', async () => {
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard worktree={makeWorktree({ linkedPR: 456 })} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('Active')
    expect(markup).toContain('bg-emerald-500')
    expect(markup).not.toContain('PR: Open')
    expect(markup).not.toContain('Linked PR #456')
  }, 20_000)

  it('keeps compact toggle-off unread and read-title visuals legacy', async () => {
    settings = { compactWorktreeCards: true, experimentalNewWorktreeCardStyle: false }
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: makeHostedReview({ status: 'failure' }),
        fetchedAt: Date.now()
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const unreadMarkup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({ linkedPR: 456, isUnread: true })}
        repo={makeRepo()}
        isActive={false}
      />
    )
    const readMarkup = renderWorktreeCardMarkup(
      <WorktreeCard worktree={makeWorktree({ linkedPR: 456 })} repo={makeRepo()} isActive={false} />
    )
    const readTitleTag = getInlineRenameTitleTag(readMarkup)

    expect(unreadMarkup).toContain('aria-label="Mark as read"')
    expect(unreadMarkup).toContain('text-amber-500')
    expect(unreadMarkup).not.toContain('PR checks: Failed · Mark read')
    expect(unreadMarkup).not.toContain('size-[13px] translate-x-px')
    expect(readTitleTag).toContain('font-normal text-foreground')
    expect(readTitleTag).not.toContain('text-foreground/80')
  }, 20_000)

  it('applies experimental unread status and read-title visuals only when enabled', async () => {
    settings = { compactWorktreeCards: true, experimentalNewWorktreeCardStyle: true }
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: makeHostedReview({ status: 'failure' }),
        fetchedAt: Date.now()
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const unreadMarkup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({ linkedPR: 456, isUnread: true })}
        repo={makeRepo()}
        isActive={false}
      />
    )
    const readMarkup = renderWorktreeCardMarkup(
      <WorktreeCard worktree={makeWorktree({ linkedPR: 456 })} repo={makeRepo()} isActive={false} />
    )

    expect(unreadMarkup).not.toContain('aria-label="Mark as read"')
    expect(unreadMarkup).toContain('PR checks: Failed · Unread')
    expect(unreadMarkup).not.toContain('Mark read')
    expect(unreadMarkup).toContain('size-[13px] translate-x-px')
    expect(unreadMarkup).not.toContain('lucide-bell')
    expect(unreadMarkup).not.toContain('text-amber-500')
    expect(unreadMarkup).toContain('data-worktree-status-lane-unread=""')
    expect(unreadMarkup).toContain('data-worktree-unread-alert=""')
    expect(unreadMarkup).toContain('bg-amber-500')
    expect(getInlineRenameTitleTag(unreadMarkup)).toContain('font-semibold text-foreground')
    expect(getInlineRenameTitleTag(readMarkup)).toContain('font-normal text-foreground/80')
  }, 20_000)

  it('shows linked GH PR status in the left status slot before hosted review details are cached when new card style is on', async () => {
    settings = { experimentalNewWorktreeCardStyle: true }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard worktree={makeWorktree({ linkedPR: 456 })} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('PR: Open')
    expect(markup).not.toContain('Linked PR #456')
  }, 20_000)

  it('does not show cached branch PR details when the worktree has no linked PR', async () => {
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: makeHostedReview({ number: 456, title: 'Stale branch PR' }),
        fetchedAt: Date.now(),
        linkedReviewHintKey: 'github:456'
      }
    }
    prCache = {
      'repo-1::feature/local-branch': {
        data: makePRInfo({ number: 456, title: 'Stale branch PR' }),
        fetchedAt: Date.now()
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({ linkedPR: null })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).not.toContain('PR #456')
    expect(markup).not.toContain('Stale branch PR')
  })

  it('shows branch-discovered GH PR status when the worktree has no linked PR', async () => {
    settings = { experimentalNewWorktreeCardStyle: true }
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: makeHostedReview({ number: 456, title: 'Branch PR', state: 'open' }),
        fetchedAt: Date.now(),
        linkedReviewHintKey: 'github:456',
        branchLookupGitHubPRNumber: 456
      }
    }
    prCache = {
      'repo-1::feature/local-branch': {
        data: makePRInfo({ number: 456, title: 'Branch PR' }),
        fetchedAt: Date.now()
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({ linkedPR: null })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('PR checks: Passing')
    expect(markup).toContain('text-emerald-500/80')
    expect(markup).not.toContain('Branch')
  })

  it('shows branch-discovered hosted review providers without linked worktree metadata', async () => {
    settings = { experimentalNewWorktreeCardStyle: true }
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: makeHostedReview({
          provider: 'bitbucket',
          number: 789,
          title: 'Bitbucket branch PR',
          url: 'https://bitbucket.org/acme/orca/pull-requests/789'
        }),
        fetchedAt: Date.now()
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({ linkedPR: null })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('PR checks: Passing')
    expect(markup).not.toContain('Linked PR #789')
  })

  it('keeps the stored branch title by default when a hosted review title is available', async () => {
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: makeHostedReview(),
        fetchedAt: Date.now()
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          displayName: 'feature/local-branch',
          linkedPR: 456
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('data-worktree-title-inline-rename=""')
    expect(markup).toContain('>feature/local-branch</span>')
    expect(markup).not.toContain('>Fix stale GH PR</span>')
  })

  it('uses the hosted review title when new card style is on and stored title is the branch', async () => {
    settings = { experimentalNewWorktreeCardStyle: true }
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: makeHostedReview(),
        fetchedAt: Date.now()
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          displayName: 'feature/local-branch',
          linkedPR: 456
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('data-worktree-title-inline-rename=""')
    expect(markup).toContain('>Fix stale GH PR</span>')
    expect(markup).not.toContain('>feature/local-branch</span>')
  })

  it('shows task and notes metadata while keeping PR out of the right metadata list', async () => {
    settings = { experimentalNewWorktreeCardStyle: true }
    worktreeCardProperties = ['status', 'issue', 'linear-issue', 'comment']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          linkedIssue: 123,
          linkedLinearIssue: 'ENG-123',
          linkedPR: 456,
          comment: 'Reviewer handoff note'
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('Linked issue #123')
    expect(markup).toContain('Linked Linear ENG-123')
    expect(markup).toContain('PR: Open')
    expect(markup).not.toContain('Linked PR #456')
    expect(markup).toContain('Workspace notes')
    expect(markup).not.toContain('data-slot="badge"')
    expect(markup).not.toContain('Loading issue')
    expect(markup).not.toContain('Reviewer handoff note')
  })

  it('shows selected task and notes metadata on compact cards when new card style is on', async () => {
    settings = { compactWorktreeCards: true, experimentalNewWorktreeCardStyle: true }
    worktreeCardProperties = ['status', 'issue', 'linear-issue', 'comment']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          linkedIssue: 123,
          linkedLinearIssue: 'ENG-123',
          linkedPR: 456,
          comment: 'Reviewer handoff note'
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('Linked issue #123')
    expect(markup).toContain('Linked Linear ENG-123')
    expect(markup).not.toContain('Linked PR #456')
    expect(markup).toContain('Workspace notes')
    expect(markup).not.toContain('data-worktree-card-meta-row=""')
    expect(markup).not.toContain('Reviewer handoff note')
  })

  it('hides individual metadata surfaces when their card properties are disabled', async () => {
    worktreeCardProperties = []
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          linkedIssue: 123,
          linkedLinearIssue: 'ENG-123',
          linkedPR: 456,
          comment: 'Reviewer handoff note'
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).not.toContain('Linked issue #123')
    expect(markup).not.toContain('Linked Linear ENG-123')
    expect(markup).not.toContain('Linked PR #456')
    expect(markup).not.toContain('Workspace notes')
    expect(markup).not.toContain('Reviewer handoff note')
  })

  it('shows automation-created workspaces as a metadata icon property', async () => {
    worktreeCardProperties = ['status', 'automation']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          automationProvenance: {
            kind: 'created-by-automation',
            automationId: 'automation-1',
            automationNameSnapshot: 'Nightly triage automation',
            automationRunId: 'run-1',
            automationRunTitleSnapshot: 'Nightly triage run',
            createdAt: 1,
            executionTargetType: 'local',
            executionTargetId: 'local',
            projectId: 'repo-1',
            repoId: 'repo-1',
            hostId: 'local'
          }
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(countAutomationCreatedLabels(markup)).toBe(1)
    expect(markup).not.toContain('>Automation</span>')
  }, 20_000)

  it('hides the automation metadata icon in compact card mode by preset default', async () => {
    settings = { compactWorktreeCards: true }
    worktreeCardProperties = [...COMPACT_WORKTREE_CARD_PROPERTIES]
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          automationProvenance: {
            kind: 'created-by-automation',
            automationId: 'automation-1',
            automationNameSnapshot: 'Nightly triage automation',
            automationRunId: 'run-1',
            automationRunTitleSnapshot: 'Nightly triage run',
            createdAt: 1,
            executionTargetType: 'local',
            executionTargetId: 'local',
            projectId: 'repo-1',
            repoId: 'repo-1',
            hostId: 'local'
          }
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(countAutomationCreatedLabels(markup)).toBe(0)
    expect(markup).not.toContain('>Automation</span>')
    expect(markup).not.toContain('Nightly triage automation')
  }, 20_000)

  it('shows the automation metadata icon in compact card mode when manually enabled', async () => {
    settings = { compactWorktreeCards: true }
    worktreeCardProperties = ['status', 'automation']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          automationProvenance: {
            kind: 'created-by-automation',
            automationId: 'automation-1',
            automationNameSnapshot: 'Nightly triage automation',
            automationRunId: 'run-1',
            automationRunTitleSnapshot: 'Nightly triage run',
            createdAt: 1,
            executionTargetType: 'local',
            executionTargetId: 'local',
            projectId: 'repo-1',
            repoId: 'repo-1',
            hostId: 'local'
          }
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(countAutomationCreatedLabels(markup)).toBe(1)
    expect(markup).not.toContain('>Automation</span>')
  }, 20_000)

  it('hides automation-created card surfaces when the Automation property is disabled', async () => {
    worktreeCardProperties = ['status']
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({
          automationProvenance: {
            kind: 'created-by-automation',
            automationId: 'automation-1',
            automationNameSnapshot: 'Nightly triage automation',
            automationRunId: 'run-1',
            automationRunTitleSnapshot: 'Nightly triage run',
            createdAt: 1,
            executionTargetType: 'local',
            executionTargetId: 'local',
            projectId: 'repo-1',
            repoId: 'repo-1',
            hostId: 'local'
          }
        })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(countAutomationCreatedLabels(markup)).toBe(0)
    expect(markup).not.toContain('>Automation</span>')
    expect(markup).not.toContain('Nightly triage automation')
  })

  it('hides live port metadata when the Ports card property is disabled', async () => {
    const worktree = makeWorktree()
    workspacePortScan = {
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
    worktreeCardProperties = []
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard worktree={worktree} repo={makeRepo()} isActive={false} />
    )

    expect(markup).not.toContain('live port')
    expect(markup).not.toContain('Live Ports')
    expect(markup).not.toContain('58941')
  })

  it('renders linked PR status in the left status slot instead of the right metadata list', async () => {
    settings = { experimentalNewWorktreeCardStyle: true }
    worktreeCardProperties = ['status']
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: makeHostedReview({ status: 'failure' }),
        fetchedAt: Date.now()
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard worktree={makeWorktree({ linkedPR: 456 })} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('PR checks: Failed')
    expect(markup).toContain('text-rose-500/85')
    expect(markup).not.toContain('Linked PR #456')
    expect(markup).not.toContain('CI checks')
  })

  it('uses branch PR cache for the status slot before hosted-review metadata warms', async () => {
    settings = { experimentalNewWorktreeCardStyle: true }
    worktreeCardProperties = ['status']
    prCache = {
      'repo-1::feature/local-branch': {
        data: makePRInfo({
          number: 6340,
          title: 'Remove split terminal from onboarding checklist',
          state: 'merged',
          headSha: 'abc123',
          checksStatus: 'success'
        }),
        fetchedAt: Date.now()
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({ linkedPR: null })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('PR: Merged')
    expect(markup).toContain('text-purple-600/70')
    expect(markup).not.toContain('Branch')
    expect(markup).not.toContain('lucide-git-branch')
  })

  it('reads the local branch PR cache for a known local repo while a runtime is focused', async () => {
    settings = {
      activeRuntimeEnvironmentId: 'env-win',
      experimentalNewWorktreeCardStyle: true
    }
    worktreeCardProperties = ['status']
    prCache = {
      'repo-1::feature/local-branch': {
        data: makePRInfo({
          number: 6341,
          title: 'Keep local PR status visible',
          state: 'open',
          checksStatus: 'pending'
        }),
        fetchedAt: Date.now()
      },
      'runtime:env-win::repo-1::feature/local-branch': {
        data: null,
        fetchedAt: Date.now()
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({ linkedPR: null })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('PR checks: Pending')
    expect(markup).not.toContain('Branch')
    expect(markup).not.toContain('lucide-git-branch')
  })

  it('keeps the detailed right-side PR badge during a transient hosted-review miss', async () => {
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: false }
    worktreeCardProperties = ['pr']
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: null,
        fetchedAt: 100
      }
    }
    prCache = {
      'repo-1::feature/local-branch': {
        data: makePRInfo({
          number: 6340,
          title: 'Remove split terminal from onboarding checklist',
          state: 'open',
          checksStatus: 'success'
        }),
        fetchedAt: 200
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({ linkedPR: null })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('Linked PR #6340')
    expect(markup).not.toContain('Linked PR #456')
  })

  it('keeps the detailed PR badge when a transient miss still has an older review hint', async () => {
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: false }
    worktreeCardProperties = ['pr']
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: null,
        fetchedAt: 100,
        linkedReviewHintKey: 'github:999'
      }
    }
    prCache = {
      'repo-1::feature/local-branch': {
        data: makePRInfo({
          number: 6340,
          title: 'Remove split terminal from onboarding checklist',
          state: 'open',
          checksStatus: 'success'
        }),
        fetchedAt: 200
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({ linkedPR: null })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('Linked PR #6340')
    expect(markup).not.toContain('Linked PR #456')
  })

  it('keeps durable non-GitHub linked review metadata ahead of branch PR cache', async () => {
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: false }
    worktreeCardProperties = ['pr']
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: null,
        fetchedAt: 100
      }
    }
    prCache = {
      'repo-1::feature/local-branch': {
        data: makePRInfo({
          number: 6340,
          title: 'Remove split terminal from onboarding checklist',
          state: 'open',
          checksStatus: 'success'
        }),
        fetchedAt: 200
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({ linkedGitLabMR: 77 })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).toContain('Linked MR #77')
    expect(markup).not.toContain('Linked PR #6340')
  })

  it('does not resurrect an older PR cache entry after a newer hosted-review miss', async () => {
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: false }
    worktreeCardProperties = ['pr']
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: null,
        fetchedAt: 200
      }
    }
    prCache = {
      'repo-1::feature/local-branch': {
        data: makePRInfo({
          number: 6340,
          title: 'Remove split terminal from onboarding checklist',
          state: 'open',
          checksStatus: 'success'
        }),
        fetchedAt: 100
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({ linkedPR: null })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).not.toContain('Linked PR #6340')
  })

  it('does not resurrect PR cache on the same millisecond as a hosted-review miss', async () => {
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: false }
    worktreeCardProperties = ['pr']
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: null,
        fetchedAt: 200
      }
    }
    prCache = {
      'repo-1::feature/local-branch': {
        data: makePRInfo({
          number: 6340,
          title: 'Remove split terminal from onboarding checklist',
          state: 'open',
          checksStatus: 'success'
        }),
        fetchedAt: 200
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderWorktreeCardMarkup(
      <WorktreeCard
        worktree={makeWorktree({ linkedPR: null })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).not.toContain('Linked PR #6340')
  })
})
