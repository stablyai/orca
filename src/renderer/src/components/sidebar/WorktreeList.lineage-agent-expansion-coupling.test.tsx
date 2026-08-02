// @vitest-environment happy-dom

// Regression test for the child-worktrees <-> agent-list expansion coupling:
// in a worktree card that shows BOTH inline agent rows (with orchestration
// lineage) AND a "N children" child-worktrees chip, toggling the child-worktrees
// chip used to reset the agent list's expansion state (it remounts the card).
// It renders the REAL WorktreeCardAgents (not a mock) inside the REAL
// WorktreeList so the remount and the durable-expansion fix are exercised
// end-to-end. The two toggles must stay independent in both directions.
//
// NOTE: unlike the sibling lineage test, this file's useVirtualizer mock HONORS
// the real `getItemKey` (which returns getRenderRowKey(row)). Without that, the
// parent card's virtual-row key would be a static `row-<index>` and the
// item<->lineage-group remount would NOT reproduce (false negative).

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../shared/agent-status-types'
import type {
  Repo,
  TerminalTab,
  Worktree,
  WorktreeCardProperty,
  WorktreeLineage
} from '../../../../shared/types'
import { clearWorktreeAgentExpansionStateForTests } from './worktree-card-agents-expansion-state'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mockStore = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  activateWorktreeFromSidebar: vi.fn(),
  openModal: vi.fn()
}))

type WorktreeListComponent = React.ComponentType<{
  scrollOffsetRef: React.RefObject<number>
  scrollAnchorRef: React.RefObject<unknown>
}>

let WorktreeList: WorktreeListComponent

vi.mock('@/store', () => {
  const useAppStore = ((selector: (state: Record<string, unknown>) => unknown) =>
    selector(mockStore.state)) as ((
    selector: (state: Record<string, unknown>) => unknown
  ) => unknown) & {
    getState: () => Record<string, unknown>
  }
  useAppStore.getState = () => mockStore.state
  return { useAppStore }
})

// Why: honor the real getItemKey so each virtual row's React key equals
// getRenderRowKey(row). This is what makes the parent card remount when it
// moves between a standalone 'item' row (key wt:...) and a 'lineage-group' row
// (key lineage-group:...) as the child-worktrees group collapses/expands.
vi.mock('@tanstack/react-virtual', () => ({
  defaultRangeExtractor: ({ startIndex, endIndex }: { startIndex: number; endIndex: number }) =>
    Array.from({ length: endIndex - startIndex + 1 }, (_, index) => startIndex + index),
  measureElement: () => 32,
  useVirtualizer: ({
    count,
    getItemKey
  }: {
    count: number
    getItemKey?: (index: number) => string | number
  }) => ({
    elementsCache: new Map(),
    getTotalSize: () => count * 96,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: getItemKey ? getItemKey(index) : `row-${index}`,
        start: index * 96
      })),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn()
  })
}))

vi.mock('@/hooks/useVirtualizedScrollAnchor', () => ({
  VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT: 'orca:test-record-scroll-anchor',
  useVirtualizedScrollAnchor: vi.fn()
}))

vi.mock('./project-header-drag', () => ({
  useRepoHeaderDrag: () => ({
    state: { draggingRepoId: null, dropIndicatorY: null },
    onHandlePointerDown: vi.fn()
  }),
  isRepoHeaderActionTarget: () => false
}))

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardContent: ({ children }: { children: ReactNode }) => (
    <div data-hover-card-content="">{children}</div>
  ),
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button onClick={onSelect}>{children}</button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/lib/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: mockStore.activateWorktreeFromSidebar
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' }),
  callRuntimeRpc: vi.fn()
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null,
  usePromptCacheCountdownForPane: () => null
}))

// NOTE: intentionally NOT mocking ./WorktreeCardAgents — we render the real one.

vi.mock('./SshDisconnectedDialog', () => ({
  SshDisconnectedDialog: () => null
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'orca:test-close-context-menus',
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope',
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu'
}))

const TAB_ID = 'tabP'
const PANE_ROOT = `${TAB_ID}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
const PANE_CHILD = `${TAB_ID}:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`
const PANE_ROOT_2 = `${TAB_ID}:cccccccc-cccc-4ccc-8ccc-cccccccccccc`

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/lineage-agent-coupling',
    displayName: 'lineage-agent-coupling',
    badgeColor: '#999999',
    addedAt: 1
  }
}

function makeWorktree(args: {
  id: string
  displayName: string
  branch: string
  sortOrder: number
  instanceId: string
}): Worktree {
  return {
    id: args.id,
    instanceId: args.instanceId,
    repoId: 'repo-1',
    path: `/tmp/lineage-agent-coupling/${args.id}`,
    displayName: args.displayName,
    branch: args.branch,
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
    sortOrder: args.sortOrder,
    lastActivityAt: args.sortOrder
  }
}

function makeLineage(worktree: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: worktree.id,
    worktreeInstanceId: worktree.instanceId!,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId!,
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' },
    createdAt: 1
  }
}

function makeAgentEntry(
  paneKey: string,
  prompt: string,
  orchestration?: AgentStatusOrchestrationContext
): AgentStatusEntry {
  const now = Date.now()
  return {
    state: 'working',
    prompt,
    updatedAt: now,
    stateStartedAt: now,
    agentType: 'claude',
    paneKey,
    worktreeId: 'parent',
    stateHistory: [],
    ...(orchestration ? { orchestration } : {})
  }
}

function makeParentTab(): TerminalTab {
  return {
    id: TAB_ID,
    ptyId: null,
    worktreeId: 'parent',
    title: 'Parent Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function setAgentLineageState(options: {
  agentActivityDisplayMode: 'compact' | 'full'
  secondRootAgent?: boolean
  collapsedGroups?: Set<string>
}): void {
  const repo = makeRepo()
  const parent = makeWorktree({
    id: 'parent',
    instanceId: 'parent-instance',
    displayName: 'lineage parent',
    branch: 'parent-branch',
    sortOrder: 20
  })
  const child = makeWorktree({
    id: 'child',
    instanceId: 'child-instance',
    displayName: 'lineage child',
    branch: 'child-branch',
    sortOrder: 10
  })
  const agentStatusByPaneKey: Record<string, AgentStatusEntry> = {
    [PANE_ROOT]: makeAgentEntry(PANE_ROOT, 'PARENT_AGENT_PROMPT'),
    [PANE_CHILD]: makeAgentEntry(PANE_CHILD, 'CHILD_AGENT_PROMPT', {
      taskId: 't1',
      dispatchId: 'd1',
      parentPaneKey: PANE_ROOT
    })
  }
  if (options.secondRootAgent) {
    agentStatusByPaneKey[PANE_ROOT_2] = makeAgentEntry(PANE_ROOT_2, 'SECOND_ROOT_PROMPT')
  }

  mockStore.state = {
    // Reactive-ish toggle: the chip's onClick eventually calls
    // toggleCollapsedGroup; mutate the live Set so the next manual re-render
    // (store isn't reactive in this harness) reflects the user's toggle.
    collapsedGroups: options.collapsedGroups ?? new Set<string>(),
    toggleCollapsedGroup: vi.fn((key: string) => {
      // Why: mirror the real store's IMMUTABLE update — a fresh Set reference is
      // what makes WorktreeList's `rows` useMemo (keyed on the Set identity)
      // recompute buildRenderableRows and flip the parent's render-row.
      const set = new Set(mockStore.state.collapsedGroups as Set<string>)
      if (set.has(key)) {
        set.delete(key)
      } else {
        set.add(key)
      }
      mockStore.state.collapsedGroups = set
    }),

    // ── worktree list plumbing ──
    activeModal: '',
    activeView: 'terminal',
    activeWorktreeId: null,
    activeWorkspaceKey: null,
    activeTabId: null,
    activeTabType: null,
    agentStatusEpoch: 0,
    browserTabsByWorktree: {},
    clearPendingRevealWorktreeId: vi.fn(),
    deleteStateByWorktreeId: {},
    detectedWorktreesByRepo: {},
    fetchFolderWorkspacePathStatus: vi.fn(),
    fetchHostedReviewForBranch: vi.fn(),
    fetchIssue: vi.fn(),
    fetchLinearIssue: vi.fn(),
    filterRepoIds: [],
    folderWorkspaces: [],
    folderWorkspacePathStatuses: {},
    getFolderWorkspacePathStatusCacheKey: (request: unknown) => JSON.stringify(request),
    getFreshFolderWorkspacePathStatus: () => null,
    gitConflictOperationByWorktree: {},
    groupBy: 'none',
    hideDefaultBranchWorkspace: false,
    hostedReviewCache: {},
    issueCache: {},
    linearIssueCache: {},
    linearStatus: null,
    migrationUnsupportedByPtyId: {},
    openModal: mockStore.openModal,
    openSettingsPage: vi.fn(),
    openSettingsTarget: null,
    openTaskPage: vi.fn(),
    pendingRevealWorktree: null,
    prCache: {},
    projectGroups: [],
    ptyIdsByTabId: {},
    recordFeatureInteraction: vi.fn(),
    remoteBranchConflictByWorktreeId: {},
    reorderRepos: vi.fn(),
    reportVisibleGitHubPRRefreshCandidates: vi.fn(),
    repos: [repo],
    retainedAgentsByPaneKey: {},
    revealWorktreeInSidebar: vi.fn(),
    runtimePaneTitlesByTabId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    setFilterRepoIds: vi.fn(),
    setHideDefaultBranchWorkspace: vi.fn(),
    setRenamingWorktreeId: vi.fn(),
    setShowSleepingWorkspaces: vi.fn(),
    setSortBy: vi.fn(),
    setWorktreesPinnedAndReveal: vi.fn(),
    settings: null,
    showSleepingWorkspaces: true,
    sortBy: 'manual',
    sortEpoch: 0,
    sshConnectedGeneration: 0,
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    terminalLayoutsByTabId: {},
    updateRepo: vi.fn(),
    updateWorktreeMeta: vi.fn(),
    updateWorktreesMeta: vi.fn(),
    workspaceHostScope: 'all',
    workspacePortScan: null,
    workspaceStatuses: [],
    worktreeCardProperties: [
      'status',
      'pr',
      'comment',
      'inline-agents'
    ] satisfies WorktreeCardProperty[],
    worktreeLineageById: { [child.id]: makeLineage(child, parent) },
    worktreesByRepo: { [repo.id]: [parent, child] },

    // ── agent-list specific state (real WorktreeCardAgents deps) ──
    agentActivityDisplayMode: options.agentActivityDisplayMode,
    agentSendPopoverTargetMode: null,
    acknowledgedAgentsByPaneKey: {},
    dropAgentStatus: vi.fn(),
    dismissRetainedAgent: vi.fn(),
    sendPromptToSidebarAgentTarget: vi.fn(),
    tabsByWorktree: { parent: [makeParentTab()] },
    agentStatusByPaneKey
  }
}

const mountedRoots: Root[] = []

async function renderWorktreeList(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(
      <WorktreeList scrollOffsetRef={{ current: 0 }} scrollAnchorRef={{ current: null }} />
    )
  })
  return { container, root }
}

// Why: the mocked store isn't reactive. Re-render with FRESH ref props so
// React.memo(WorktreeList) doesn't bail out, letting a collapsedGroups mutation
// flow into buildRenderableRows (and thus flip the parent's virtual-row key).
async function rerender(root: Root): Promise<void> {
  await act(async () => {
    root.render(
      <WorktreeList scrollOffsetRef={{ current: 0 }} scrollAnchorRef={{ current: null }} />
    )
  })
}

function findButtonByAriaLabel(container: HTMLElement, pattern: RegExp): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((button) =>
      pattern.test(button.getAttribute('aria-label') ?? '')
    ) ?? null
  )
}

function childWorktreeChip(container: HTMLElement): HTMLButtonElement | null {
  return findButtonByAriaLabel(container, /child workspace/i)
}

function agentChildDisclosure(container: HTMLElement): HTMLButtonElement | null {
  return findButtonByAriaLabel(container, /child agent/i)
}

function compactAgentSummary(container: HTMLElement): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>('button.compact-agent-summary-button')][0] ??
    null
  )
}

function childWorktreeCardPresent(container: HTMLElement): boolean {
  return container.querySelector('[id="worktree-list-option-all%3Achild"]') !== null
}

function parentVirtualRowKey(container: HTMLElement): string | null {
  return (
    container
      .querySelector('[data-worktree-id="parent"]')
      ?.closest('[data-worktree-virtual-row]')
      ?.getAttribute('data-worktree-virtual-row-key') ?? null
  )
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('WorktreeCard agent-list <-> child-worktrees expansion coupling', () => {
  beforeAll(async () => {
    WorktreeList = (await import('./WorktreeList')).default as WorktreeListComponent
  }, 60_000)

  beforeEach(() => {
    vi.clearAllMocks()
    // Expansion now persists in a module-level cache that survives remounts, so
    // it must be reset between cases or one test's collapse leaks into the next.
    clearWorktreeAgentExpansionStateForTests()
  })

  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
    clearWorktreeAgentExpansionStateForTests()
  })

  it('[full mode] both toggles render independently at mount', async () => {
    setAgentLineageState({ agentActivityDisplayMode: 'full' })
    const { container } = await renderWorktreeList()

    // Same-tab lineage children must not inherit the parent's conversation name.
    expect(container.textContent).toContain('Parent Terminal')
    expect(container.textContent).not.toContain('PARENT_AGENT_PROMPT')
    expect(container.textContent).toContain('CHILD_AGENT_PROMPT')

    // Both controls exist and are independent DOM elements.
    expect(childWorktreeChip(container)).not.toBeNull()
    expect(agentChildDisclosure(container)).not.toBeNull()

    // Defaults: child worktrees expanded (chip aria-expanded true) AND child
    // agents expanded (disclosure aria-expanded true).
    expect(childWorktreeChip(container)!.getAttribute('aria-expanded')).toBe('true')
    expect(agentChildDisclosure(container)!.getAttribute('aria-expanded')).toBe('true')
    expect(childWorktreeCardPresent(container)).toBe(true)
  })

  it('[full mode] toggling AGENTS does NOT change the child-worktrees chip (agents -> children uncoupled)', async () => {
    setAgentLineageState({ agentActivityDisplayMode: 'full' })
    const { container } = await renderWorktreeList()

    expect(agentChildDisclosure(container)!.getAttribute('aria-expanded')).toBe('true')
    expect(childWorktreeCardPresent(container)).toBe(true)

    // Collapse the child AGENTS via the disclosure chevron.
    await click(agentChildDisclosure(container)!)

    // Agent children now collapsed (local state)...
    expect(agentChildDisclosure(container)!.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.worktree-agent-lineage-children')).toBeNull()
    // ...but the child WORKTREES are untouched: chip still expanded, child card present.
    expect(childWorktreeChip(container)!.getAttribute('aria-expanded')).toBe('true')
    expect(childWorktreeCardPresent(container)).toBe(true)
    // And collapsedGroups was never mutated by an agent toggle.
    expect((mockStore.state.collapsedGroups as Set<string>).size).toBe(0)
  })

  it('[full mode] toggling CHILD WORKTREES still remounts the card but PRESERVES agent expansion (regression)', async () => {
    setAgentLineageState({ agentActivityDisplayMode: 'full' })
    const { container, root } = await renderWorktreeList()

    // Parent starts inside a lineage-group render row (children expanded).
    expect(parentVirtualRowKey(container)).toBe('lineage-group:all:lineage:parent')

    // User collapses the child AGENTS.
    await click(agentChildDisclosure(container)!)
    expect(agentChildDisclosure(container)!.getAttribute('aria-expanded')).toBe('false')

    // User now clicks the CHILD-WORKTREES chip to collapse child worktrees.
    await click(childWorktreeChip(container)!)
    expect(mockStore.state.toggleCollapsedGroup).toHaveBeenCalledWith('lineage:parent')
    // Store isn't reactive; flush the collapsedGroups change into a re-render.
    await rerender(root)

    // The remount still happens: the parent moved to a standalone 'item' render
    // row with a DIFFERENT React key, and the child card is gone.
    expect(parentVirtualRowKey(container)).toBe('wt:all:parent')
    expect(childWorktreeCardPresent(container)).toBe(false)

    // FIXED: the card remounted, but the durable expansion cache means the
    // child AGENTS the user collapsed stay collapsed — the child-worktrees
    // toggle no longer bleeds into the agent list.
    expect(agentChildDisclosure(container)!.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.worktree-agent-lineage-children')).toBeNull()
  })

  it('[full mode] CONTROL: a re-render that does NOT change collapsedGroups preserves agent state (isolates the remount)', async () => {
    setAgentLineageState({ agentActivityDisplayMode: 'full' })
    const { container, root } = await renderWorktreeList()

    await click(agentChildDisclosure(container)!)
    expect(agentChildDisclosure(container)!.getAttribute('aria-expanded')).toBe('false')

    // Re-render WITHOUT touching collapsedGroups: the parent's virtual-row key
    // stays 'lineage-group:all:lineage:parent', so there is no remount.
    await rerender(root)

    expect(parentVirtualRowKey(container)).toBe('lineage-group:all:lineage:parent')
    // Agent collapse survives => proves it is the KEY change (remount), not the
    // re-render itself, that resets the agent expansion.
    expect(agentChildDisclosure(container)!.getAttribute('aria-expanded')).toBe('false')
  })

  it('[compact mode] toggling CHILD WORKTREES preserves the compact agent summary expansion (regression)', async () => {
    setAgentLineageState({ agentActivityDisplayMode: 'compact', secondRootAgent: true })
    const { container, root } = await renderWorktreeList()

    // Two root agents => compact summary pill is shown, collapsed by default.
    const summary = compactAgentSummary(container)
    expect(summary).not.toBeNull()
    expect(summary!.getAttribute('aria-expanded')).toBe('false')

    // User expands the compact agent summary.
    await click(summary!)
    expect(compactAgentSummary(container)!.getAttribute('aria-expanded')).toBe('true')

    // User toggles child worktrees.
    await click(childWorktreeChip(container)!)
    expect(mockStore.state.toggleCollapsedGroup).toHaveBeenCalledWith('lineage:parent')
    await rerender(root)

    // FIXED: the card remounts (child card gone), but the expanded "N agents"
    // summary is restored from the durable cache instead of collapsing.
    expect(childWorktreeCardPresent(container)).toBe(false)
    expect(compactAgentSummary(container)!.getAttribute('aria-expanded')).toBe('true')
  })
})
