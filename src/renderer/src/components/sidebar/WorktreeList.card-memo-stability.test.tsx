// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree, WorktreeCardProperty } from '../../../../shared/types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mockStore = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  activateWorktreeFromSidebar: vi.fn(),
  openModal: vi.fn()
}))

// Counts invocations of the memo'd card's inner render function. A bail-out
// (React.memo shallow-equal props) does NOT invoke it — which is the claim
// under test: order-preserving epoch bumps must not re-render cards.
const cardRenderSpy = vi.hoisted(() => vi.fn())

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

vi.mock('@tanstack/react-virtual', () => ({
  defaultRangeExtractor: ({ startIndex, endIndex }: { startIndex: number; endIndex: number }) =>
    Array.from({ length: endIndex - startIndex + 1 }, (_, index) => startIndex + index),
  measureElement: () => 32,
  useVirtualizer: ({ count }: { count: number }) => ({
    elementsCache: new Map(),
    getTotalSize: () => count * 96,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: `row-${index}`,
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
  HoverCardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

vi.mock('./WorktreeCardAgents', () => ({
  default: () => <div>Agent row</div>,
  SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT: 'orca:test-suppress-scroll-adjustment'
}))

vi.mock('./WorktreeCard', async () => {
  const ReactModule = await import('react')
  const MockWorktreeCard = ReactModule.memo(function WorktreeCard({
    worktree
  }: {
    worktree: Worktree
  }) {
    cardRenderSpy(worktree.id)
    return <div data-mock-worktree-card={worktree.id} />
  })
  return { default: MockWorktreeCard }
})

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/card-memo-stability',
    displayName: 'card-memo-stability',
    badgeColor: '#999999',
    addedAt: 1
  }
}

function makeWorktree(args: { id: string; displayName: string; sortOrder: number }): Worktree {
  return {
    id: args.id,
    instanceId: `${args.id}-instance`,
    repoId: 'repo-1',
    path: `/tmp/card-memo-stability/${args.id}`,
    displayName: args.displayName,
    branch: `${args.id}-branch`,
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

function makeFolderWorkspacePathStatusState(): Record<string, unknown> {
  return {
    fetchFolderWorkspacePathStatus: vi.fn(),
    folderWorkspacePathStatuses: {},
    folderWorkspaces: [],
    getFolderWorkspacePathStatusCacheKey: (request: unknown) => JSON.stringify(request),
    getFreshFolderWorkspacePathStatus: vi.fn(() => null)
  }
}

function setFlatWorktreeState(): void {
  const repo = makeRepo()
  const worktrees = [
    makeWorktree({ id: 'wt-a', displayName: 'alpha', sortOrder: 20 }),
    makeWorktree({ id: 'wt-b', displayName: 'beta', sortOrder: 10 })
  ]
  mockStore.state = {
    ...makeFolderWorkspacePathStatusState(),
    activeModal: '',
    activeView: 'terminal',
    activeWorktreeId: null,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserTabsByWorktree: {},
    clearPendingRevealWorktreeId: vi.fn(),
    collapsedGroups: new Set<string>(),
    deleteStateByWorktreeId: {},
    detectedWorktreesByRepo: {},
    fetchHostedReviewForBranch: vi.fn(),
    fetchIssue: vi.fn(),
    fetchLinearIssue: vi.fn(),
    filterRepoIds: [],
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
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    toggleCollapsedGroup: vi.fn(),
    updateRepo: vi.fn(),
    updateWorktreeMeta: vi.fn(),
    updateWorktreesMeta: vi.fn(),
    workspaceHostScope: 'all',
    workspacePortScan: null,
    workspaceStatuses: [],
    worktreeCardProperties: ['status', 'pr', 'comment'] satisfies WorktreeCardProperty[],
    worktreeLineageById: {},
    worktreesByRepo: {
      [repo.id]: worktrees
    }
  }
}

const mountedRoots: Root[] = []

async function renderList(root: Root): Promise<void> {
  await act(async () => {
    // Why fresh ref objects each render: they defeat WorktreeList's own memo
    // like a store-subscription re-render would, so the test exercises a full
    // parent re-render and isolates whether the CARDS bail.
    root.render(
      <WorktreeList scrollOffsetRef={{ current: 0 }} scrollAnchorRef={{ current: null }} />
    )
  })
}

describe('WorktreeCard memo bail-out across epoch bumps', () => {
  beforeAll(async () => {
    WorktreeList = (await import('./WorktreeList')).default as WorktreeListComponent
  }, 60_000)

  beforeEach(() => {
    vi.clearAllMocks()
    setFlatWorktreeState()
  })

  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  it('does not re-render cards on an order-preserving sortEpoch bump', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mountedRoots.push(root)

    await renderList(root)
    expect(container.querySelectorAll('[data-mock-worktree-card]')).toHaveLength(2)

    // Baseline: a parent re-render with unchanged store state must not
    // re-invoke card render functions.
    const countAfterMount = cardRenderSpy.mock.calls.length
    await renderList(root)
    expect(cardRenderSpy.mock.calls.length).toBe(countAfterMount)

    // Order-preserving epoch bump: same worktrees, same order, new epoch.
    // Manual sort applies the bump without the smart-sort settle debounce.
    mockStore.state = { ...mockStore.state, sortEpoch: 1 }
    await renderList(root)

    expect(cardRenderSpy.mock.calls.length).toBe(countAfterMount)
  })

  it('re-renders a card when its own worktree data changes', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mountedRoots.push(root)

    await renderList(root)
    const countAfterMount = cardRenderSpy.mock.calls.length

    const worktrees = (mockStore.state.worktreesByRepo as Record<string, Worktree[]>)['repo-1']!
    mockStore.state = {
      ...mockStore.state,
      sortEpoch: 2,
      worktreesByRepo: {
        'repo-1': [{ ...worktrees[0]!, displayName: 'alpha renamed' }, worktrees[1]!]
      }
    }
    await renderList(root)

    // The changed card re-renders; identity reuse must not freeze real updates.
    expect(cardRenderSpy.mock.calls.length).toBeGreaterThan(countAfterMount)
    expect(cardRenderSpy).toHaveBeenCalledWith('wt-a')
  })
})
