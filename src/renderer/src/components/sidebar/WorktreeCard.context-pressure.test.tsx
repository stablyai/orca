import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { GlobalSettings, Repo, Worktree, WorktreeCardProperty } from '../../../../shared/types'

const cacheTimerMocks = vi.hoisted(() => ({
  usePromptCacheCountdownStartedAt: vi.fn()
}))

let worktreeCardProperties: WorktreeCardProperty[] = ['status', 'context-pressure']
let settings: Partial<GlobalSettings> | null = null
let agentStatusByPaneKey: Record<string, AgentStatusEntry> = {}
let tabsByWorktree: Record<string, unknown[]> = {}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      agentActivityDisplayMode: undefined,
      agentStatusByPaneKey,
      browserTabsByWorktree: {},
      createBrowserTab: vi.fn(),
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch: vi.fn(),
      fetchIssue: vi.fn(),
      fetchLinearIssue: vi.fn(),
      gitConflictOperationByWorktree: {},
      hostedReviewCache: {},
      issueCache: {},
      linearIssueCache: {},
      migrationUnsupportedByPtyId: {},
      openModal: vi.fn(),
      openTaskPage: vi.fn(),
      projectGroups: [],
      ptyIdsByTabId: {},
      recordFeatureInteraction: vi.fn(),
      remoteBranchConflictByWorktreeId: {},
      retainedAgentsByPaneKey: {},
      setRemoteBrowserPageHandle: vi.fn(),
      setWorkspacePortScan: vi.fn(),
      setWorkspacePortScanRefreshing: vi.fn(),
      settings,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      tabsByWorktree,
      updateWorktreeMeta: vi.fn(),
      workspacePortScan: null,
      worktreeCardProperties
    })
}))

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  HoverCardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-tooltip-content="">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/lib/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'active'
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: cacheTimerMocks.usePromptCacheCountdownStartedAt
}))

vi.mock('./useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: vi.fn(() => [])
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => <div data-worktree-agents="" />
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

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const WORKTREE_ID = 'repo-1::/repo/worktrees/pressure'

function makeRepo(): Repo {
  return { id: 'repo-1', path: '/repo', displayName: 'orca', badgeColor: '#999999', addedAt: 1 }
}

function makeWorktree(): Worktree {
  return {
    id: WORKTREE_ID,
    repoId: 'repo-1',
    path: '/repo/worktrees/pressure',
    displayName: 'Pressure check',
    branch: 'feature/pressure',
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

function entry(paneKey: string, usedTokens: number): AgentStatusEntry {
  return {
    paneKey,
    state: 'working',
    prompt: 'fill the window',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    stateHistory: [],
    agentType: 'claude',
    model: 'claude-sonnet-4-5',
    worktreeId: WORKTREE_ID,
    contextUsage: { usedTokens, maxTokens: 200_000 }
  }
}

function setLiveAgents(...entries: AgentStatusEntry[]): void {
  agentStatusByPaneKey = Object.fromEntries(entries.map((e) => [e.paneKey, e]))
  tabsByWorktree = {
    [WORKTREE_ID]: [
      {
        id: 'tab-1',
        ptyId: 'pty-1',
        worktreeId: WORKTREE_ID,
        title: 'agent',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
  }
}

async function renderCard(): Promise<string> {
  const { default: WorktreeCard } = await import('./WorktreeCard')
  return renderToStaticMarkup(
    <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
  )
}

describe('WorktreeCard context pressure aggregate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = ['status', 'context-pressure']
    settings = { experimentalContextPressure: true }
    cacheTimerMocks.usePromptCacheCountdownStartedAt.mockReturnValue(null)
    setLiveAgents(entry(`tab-1:${LEAF_A}`, 195_000))
  })

  it('shows the worst-of dot in the detailed card meta row', async () => {
    const markup = await renderCard()
    expect(markup).toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('data-context-pressure="critical"')
  })

  it('shows the dot on compact cards even without other meta badges', async () => {
    settings = { experimentalContextPressure: true, compactWorktreeCards: true }
    const markup = await renderCard()
    expect(markup).toContain('data-worktree-card-meta-row=""')
    expect(markup).toContain('data-context-pressure="critical"')
  })

  it('shows the dot on the new card style', async () => {
    settings = { experimentalContextPressure: true, experimentalNewWorktreeCardStyle: true }
    const markup = await renderCard()
    expect(markup).toContain('data-context-pressure="critical"')
  })

  it('aggregates worst-of across the worktree agents', async () => {
    setLiveAgents(entry(`tab-1:${LEAF_A}`, 100_000), entry(`tab-1:${LEAF_B}`, 160_000))
    const markup = await renderCard()
    expect(markup).toContain('data-context-pressure="warning"')
  })

  it("stays quiet when every session is 'ok' (aggregate is alert-only)", async () => {
    setLiveAgents(entry(`tab-1:${LEAF_A}`, 100_000))
    expect(await renderCard()).not.toContain('data-context-pressure')
  })

  it('renders nothing when the experimental flag is off', async () => {
    settings = {}
    expect(await renderCard()).not.toContain('data-context-pressure')
  })

  it("renders nothing when the 'context-pressure' card property is hidden", async () => {
    worktreeCardProperties = ['status']
    expect(await renderCard()).not.toContain('data-context-pressure')
  })

  it('renders nothing when no session reports usage', async () => {
    const noData = entry(`tab-1:${LEAF_A}`, 0)
    delete (noData as { contextUsage?: unknown }).contextUsage
    setLiveAgents(noData)
    expect(await renderCard()).not.toContain('data-context-pressure')
  })
})
