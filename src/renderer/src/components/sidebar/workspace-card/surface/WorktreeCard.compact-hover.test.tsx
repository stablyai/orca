import { renderToStaticMarkup } from 'react-dom/server'
import React, { type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/rows/dashboard-agent-row'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { WorktreeCardProperty } from '../../../../../../shared/ui-chrome/ui-chrome-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorkspacePortScanResult } from '../../../../../../shared/workspace/ports/workspace-ports'
import type { WorktreeStatus } from '../../../../../../shared/worktree/row-display/worktree-status-rollup'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const openTaskPage = vi.fn()
const updateWorktreeMeta = vi.fn()
const recordFeatureInteraction = vi.fn()
const replaceWorkspacePortScans = vi.fn()
const setWorkspacePortScanRefreshing = vi.fn()
const cacheTimerMocks = vi.hoisted(() => ({
  usePromptCacheCountdownStartedAt: vi.fn()
}))

let worktreeCardProperties: WorktreeCardProperty[] = ['status', 'ports']
let hostedReviewCache: Record<string, unknown> = {}
let issueCache: Record<string, unknown> = {}
let projectGroups: unknown[] = []
let workspacePortScan: { key: string; result: WorkspacePortScanResult } | null = null
let settings: Partial<GlobalSettings> | null = { compactWorktreeCards: true }
let agentActivityDisplayMode: 'compact' | 'full' | undefined
let mockInlineAgentRows: DashboardAgentRowData[] = []

vi.mock('@/store', () => {
  const getState = () => ({
    browserTabsByWorktree: {},
    agentActivityDisplayMode,
    createBrowserTab: vi.fn(),
    deleteStateByWorktreeId: {},
    fetchHostedReviewForBranch,
    fetchIssue,
    fetchLinearIssue,
    gitConflictOperationByWorktree: {},
    hostedReviewCache,
    issueCache,
    linearIssueCache: {},
    openModal,
    openTaskPage,
    projectGroups,
    ptyIdsByTabId: {},
    recordFeatureInteraction,
    remoteBranchConflictByWorktreeId: {},
    setRemoteBrowserPageHandle: vi.fn(),
    replaceWorkspacePortScans,
    setWorkspacePortScanRefreshing,
    settings,
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    tabsByWorktree: {},
    updateWorktreeMeta,
    workspacePortScan,
    worktreeCardProperties
  })
  return {
    useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(getState()), {
      getState
    })
  }
})

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children, openDelay }: { children: ReactNode; openDelay?: number }) => (
    <div data-hover-open-delay={openDelay}>{children}</div>
  ),
  HoverCardContent: ({ children }: { children: ReactNode }) => (
    <div data-hover-card-content="">{children}</div>
  ),
  HoverCardTrigger: ({ children }: { children: ReactNode }) =>
    React.isValidElement<Record<string, unknown>>(children) ? (
      React.cloneElement(children, {
        'data-hover-card-trigger': ''
      })
    ) : (
      <>{children}</>
    )
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/lib/workspace/activation/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: vi.fn()
}))

let mockActivityStatus: WorktreeStatus = 'active'

vi.mock('../activity/use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => mockActivityStatus
}))

vi.mock('../../workspace-actions/sleep/use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false,
  selectIsSleepingWorktree: () => false
}))

vi.mock('../activity/CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: cacheTimerMocks.usePromptCacheCountdownStartedAt
}))

vi.mock('../activity/useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: vi.fn(() => mockInlineAgentRows)
}))

vi.mock('../activity/WorktreeCardAgents', () => ({
  default: ({ className }: { className?: string }) => (
    <div className={className} data-worktree-agents="" />
  )
}))

vi.mock('../../workspace-actions/context-menu/WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
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

describe('WorktreeCard compact hover details', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = ['status', 'ports']
    hostedReviewCache = {}
    issueCache = {}
    projectGroups = []
    workspacePortScan = null
    settings = { compactWorktreeCards: true }
    agentActivityDisplayMode = undefined
    mockInlineAgentRows = []
    mockActivityStatus = 'active'
    cacheTimerMocks.usePromptCacheCountdownStartedAt.mockReturnValue(null)
  })

  it('draws one Compact line with the project at its end, whatever the card setting', async () => {
    settings = { compactWorktreeCards: false }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ displayName: 'feature/local-branch' })}
        repo={makeRepo()}
        isActive={false}
        compactLine
      />
    )

    // The project row's chip, once, after the title.
    expect(markup.match(/aria-label="Project orca"/g)).toHaveLength(1)
    expect(markup).toMatch(/feature\/local-branch<\/span>.*aria-label="Project orca"/s)
    expect(markup).not.toContain('data-worktree-card-meta-row')
  })

  it("shows a line's agents by kind, two at most, then +N, all before its title", async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the line reads only agentType, rowSource and state.
    mockInlineAgentRows = [
      { agentType: 'codex', rowSource: 'live', state: 'working' },
      { agentType: 'claude', rowSource: 'subagent', state: 'working' },
      { agentType: 'claude', rowSource: 'retained', state: 'done' },
      { agentType: 'gemini', rowSource: 'live', state: 'working' }
    ] as DashboardAgentRowData[]
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const line = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} compactLine />
    )
    expect(line).toMatch(/aria-label="Codex, Claude".*>\+1<.*Fix stale GH PR/s)

    const card = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )
    expect(card).not.toContain('data-worktree-card-line-agent')
    expect(card).not.toContain('>+1<')
  })

  it("puts a line's agent rows under its status in the hover card", async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the agent list is mocked and only counts rows.
    mockInlineAgentRows = [{} as DashboardAgentRowData]
    mockActivityStatus = 'working'
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} compactLine />
    )

    expect(markup).toContain('data-worktree-card-line-activity=""')
    expect(markup).toContain('Working')
    expect(markup).toContain('data-worktree-agents=""')
  })

  it('says a waiting line needs permission in its hover card, even before its agent row arrives', async () => {
    mockActivityStatus = 'permission'
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} compactLine />
    )

    expect(markup).toContain('Needs permission')
  })

  it('leaves the status section out of a quiet line and of ordinary compact cards', async () => {
    const { default: WorktreeCard } = await import('./WorktreeCard')
    expect(
      renderToStaticMarkup(
        <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} compactLine />
      )
    ).not.toContain('data-worktree-card-line-activity')

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the agent list is mocked and only counts rows.
    mockInlineAgentRows = [{} as DashboardAgentRowData]
    expect(
      renderToStaticMarkup(
        <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
      )
    ).not.toContain('data-worktree-card-line-activity')
  })
})
