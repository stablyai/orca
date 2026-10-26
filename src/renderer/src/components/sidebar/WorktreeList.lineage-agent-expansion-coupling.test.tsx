// @vitest-environment happy-dom

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn().mockResolvedValue(false)
}))

// Render real list/agents so changing lineage row keys remounts cards and exercises disclosure persistence independently of child-worktree expansion.

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../shared/agent-status-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { clearWorktreeAgentExpansionStateForTests } from './worktree-card-agents-expansion-state'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mockStore = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  setVisibleReviewCardWorktreeIds: vi.fn<(ids: readonly string[]) => void>(),
  activateWorktreeFromSidebar: vi.fn(),
  openModal: vi.fn()
}))

type WorktreeListComponent = React.ComponentType<{
  scrollOffsetRef: React.RefObject<number>
  scrollAnchorRef: React.RefObject<unknown>
}>

let WorktreeList: WorktreeListComponent

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mockStore.state),
    {
      getState: () => mockStore.state,
      subscribe: () => () => {}
    }
  )
}))

// Honor getItemKey so toggling standalone/lineage-group rows changes React keys and reproduces the card remount.
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

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null,
  usePromptCacheCountdownForPane: () => null
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
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
    collapsedGroups: options.collapsedGroups ?? new Set<string>(),
    toggleCollapsedGroup: vi.fn((key: string) => {
      // Replace the Set immutably so the list’s identity-keyed memo rebuilds render rows.
      const set = new Set(mockStore.state.collapsedGroups as Set<string>)
      if (set.has(key)) {
        set.delete(key)
      } else {
        set.add(key)
      }
      mockStore.state.collapsedGroups = set
    }),

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
    setVisibleReviewCardWorktreeIds: mockStore.setVisibleReviewCardWorktreeIds,
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

// The mock store is not reactive; fresh ref props bypass memo so changed groups rebuild render keys.
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
  return container.querySelector('[id="worktree-list-option-all%3A%7Cchild"]') !== null
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
    // Clear module-scoped expansion between tests because it intentionally survives remounts.
    clearWorktreeAgentExpansionStateForTests()
  })

  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
      // Lazy markdown imports must finish before Vitest tears down the module environment.
      await vi.dynamicImportSettled()
    })
    document.body.innerHTML = ''
    clearWorktreeAgentExpansionStateForTests()
  })

  it('[full mode] both toggles render independently at mount', async () => {
    setAgentLineageState({ agentActivityDisplayMode: 'full' })
    const { container } = await renderWorktreeList()

    expect(container.textContent).toContain('Parent Terminal')
    expect(container.textContent).not.toContain('PARENT_AGENT_PROMPT')
    expect(container.textContent).toContain('CHILD_AGENT_PROMPT')

    expect(childWorktreeChip(container)).not.toBeNull()
    expect(agentChildDisclosure(container)).not.toBeNull()

    expect(childWorktreeChip(container)!.getAttribute('aria-expanded')).toBe('true')
    expect(agentChildDisclosure(container)!.getAttribute('aria-expanded')).toBe('true')
    expect(childWorktreeCardPresent(container)).toBe(true)
  })

  it('[full mode] toggling AGENTS does NOT change the child-worktrees chip (agents -> children uncoupled)', async () => {
    setAgentLineageState({ agentActivityDisplayMode: 'full' })
    const { container } = await renderWorktreeList()

    expect(agentChildDisclosure(container)!.getAttribute('aria-expanded')).toBe('true')
    expect(childWorktreeCardPresent(container)).toBe(true)

    await click(agentChildDisclosure(container)!)

    expect(agentChildDisclosure(container)!.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.worktree-agent-lineage-children')).toBeNull()
    expect(childWorktreeChip(container)!.getAttribute('aria-expanded')).toBe('true')
    expect(childWorktreeCardPresent(container)).toBe(true)
    expect((mockStore.state.collapsedGroups as Set<string>).size).toBe(0)
  })

  it('[full mode] toggling CHILD WORKTREES still remounts the card but PRESERVES agent expansion (regression)', async () => {
    setAgentLineageState({ agentActivityDisplayMode: 'full' })
    const { container, root } = await renderWorktreeList()

    expect(parentVirtualRowKey(container)).toBe('lineage-group:all:lineage:parent')

    await click(agentChildDisclosure(container)!)
    expect(agentChildDisclosure(container)!.getAttribute('aria-expanded')).toBe('false')

    await click(childWorktreeChip(container)!)
    expect(mockStore.state.toggleCollapsedGroup).toHaveBeenCalledWith('lineage:parent')
    await rerender(root)

    // Verify the parent actually remounted under a different row key; otherwise persistence would pass without exercising the bug.
    expect(parentVirtualRowKey(container)).toBe('wt:all:|parent')
    expect(childWorktreeCardPresent(container)).toBe(false)

    expect(agentChildDisclosure(container)!.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.worktree-agent-lineage-children')).toBeNull()
  })

  it('[compact mode] toggling CHILD WORKTREES preserves the compact agent summary expansion (regression)', async () => {
    setAgentLineageState({ agentActivityDisplayMode: 'compact', secondRootAgent: true })
    const { container, root } = await renderWorktreeList()

    const summary = compactAgentSummary(container)
    expect(summary).not.toBeNull()
    expect(summary!.getAttribute('aria-expanded')).toBe('false')

    await click(summary!)
    expect(compactAgentSummary(container)!.getAttribute('aria-expanded')).toBe('true')

    await click(childWorktreeChip(container)!)
    expect(mockStore.state.toggleCollapsedGroup).toHaveBeenCalledWith('lineage:parent')
    await rerender(root)

    expect(childWorktreeCardPresent(container)).toBe(false)
    expect(compactAgentSummary(container)!.getAttribute('aria-expanded')).toBe('true')
  })
})
