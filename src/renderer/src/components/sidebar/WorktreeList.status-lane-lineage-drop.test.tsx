// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Repo,
  WorkspaceStatus,
  Worktree,
  WorktreeCardProperty,
  WorktreeLineage,
  WorktreeMeta
} from '../../../../shared/types'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../shared/workspace-status-defaults'
import {
  WORKSPACE_STATUS_DRAG_IDS_TYPE,
  WORKSPACE_STATUS_DRAG_TYPE
} from './workspace-status-drag-data'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mockStore = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  activateWorktreeFromSidebar: vi.fn(),
  openModal: vi.fn(),
  updateWorktreeMeta: vi.fn(),
  updateWorktreesMeta: vi.fn(),
  setSortBy: vi.fn(),
  fetchHostedReviewForBranch: vi.fn(),
  fetchIssue: vi.fn(),
  fetchLinearIssue: vi.fn(),
  openTaskPage: vi.fn()
}))

type WorktreeListComponent = React.ComponentType<{
  scrollOffsetRef: React.RefObject<number>
  scrollAnchorRef: React.RefObject<unknown>
}>

let WorktreeList: WorktreeListComponent

function makeFolderWorkspacePathStatusMockState(): Record<string, unknown> {
  return {
    fetchFolderWorkspacePathStatus: vi.fn(),
    folderWorkspaces: [],
    folderWorkspacePathStatuses: {},
    getFolderWorkspacePathStatusCacheKey: (request: unknown) => JSON.stringify(request),
    getFreshFolderWorkspacePathStatus: () => null
  }
}

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
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: ({ worktreeId }: { worktreeId: string }) => (
    <div data-agent-worktree-id={worktreeId}>Agent row</div>
  ),
  SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT: 'orca:test-suppress-scroll-adjustment'
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

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/status-lane-lineage',
    displayName: 'status-lane-lineage',
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
  workspaceStatus: WorkspaceStatus
}): Worktree {
  return {
    id: args.id,
    instanceId: args.instanceId,
    repoId: 'repo-1',
    path: `/tmp/status-lane-lineage/${args.id}`,
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
    lastActivityAt: args.sortOrder,
    workspaceStatus: args.workspaceStatus
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

function makeFolderWorkspacePathStatusState(): Record<string, unknown> {
  return {
    fetchFolderWorkspacePathStatus: vi.fn(),
    folderWorkspacePathStatuses: {},
    folderWorkspaces: [],
    getFolderWorkspacePathStatusCacheKey: (request: unknown) => JSON.stringify(request),
    getFreshFolderWorkspacePathStatus: vi.fn(() => null)
  }
}

// Grouped by workspace status: parent + its visible lineage child both live in the
// "in-progress" lane; an unrelated bystander sits in "todo".
function setStatusLaneState(): void {
  const repo = makeRepo()
  const parent = makeWorktree({
    id: 'parent',
    instanceId: 'parent-instance',
    displayName: 'lineage parent',
    branch: 'parent-branch',
    sortOrder: 30,
    workspaceStatus: 'in-progress'
  })
  const child = makeWorktree({
    id: 'child',
    instanceId: 'child-instance',
    displayName: 'lineage child',
    branch: 'child-branch',
    sortOrder: 20,
    workspaceStatus: 'in-progress'
  })
  const bystander = makeWorktree({
    id: 'bystander',
    instanceId: 'bystander-instance',
    displayName: 'bystander',
    branch: 'bystander-branch',
    sortOrder: 10,
    workspaceStatus: 'todo'
  })
  mockStore.state = {
    ...makeFolderWorkspacePathStatusMockState(),
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
    fetchHostedReviewForBranch: mockStore.fetchHostedReviewForBranch,
    fetchIssue: mockStore.fetchIssue,
    fetchLinearIssue: mockStore.fetchLinearIssue,
    filterRepoIds: [],
    ...makeFolderWorkspacePathStatusState(),
    gitConflictOperationByWorktree: {},
    groupBy: 'workspace-status',
    hideDefaultBranchWorkspace: false,
    hostedReviewCache: {},
    issueCache: {},
    linearIssueCache: {},
    linearStatus: null,
    migrationUnsupportedByPtyId: {},
    openModal: mockStore.openModal,
    openSettingsPage: vi.fn(),
    openSettingsTarget: null,
    openTaskPage: mockStore.openTaskPage,
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
    setSortBy: mockStore.setSortBy,
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
    updateWorktreeMeta: mockStore.updateWorktreeMeta,
    updateWorktreesMeta: mockStore.updateWorktreesMeta,
    workspaceHostScope: 'all',
    workspacePortScan: null,
    workspaceStatuses: [...DEFAULT_WORKSPACE_STATUSES],
    worktreeCardProperties: [
      'status',
      'pr',
      'comment',
      'inline-agents'
    ] satisfies WorktreeCardProperty[],
    worktreeLineageById: { [child.id]: makeLineage(child, parent) },
    worktreesByRepo: { [repo.id]: [parent, child, bystander] }
  }
}

const mountedRoots: Root[] = []

async function renderWorktreeList(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(
      <WorktreeList scrollOffsetRef={{ current: 0 }} scrollAnchorRef={{ current: null }} />
    )
  })
  return container
}

// A minimal DataTransfer stand-in: the native-drop commit path only reads the
// worktree-id payloads and the type list off it.
function makeWorktreeIdDataTransfer(worktreeIds: readonly string[]): DataTransfer {
  const [firstId] = worktreeIds
  const data: Record<string, string> = {
    [WORKSPACE_STATUS_DRAG_TYPE]: firstId ?? '',
    [WORKSPACE_STATUS_DRAG_IDS_TYPE]: JSON.stringify(worktreeIds),
    'text/plain': firstId ?? ''
  }
  return {
    effectAllowed: 'move',
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? '',
    setData: () => {}
  } as unknown as DataTransfer
}

function findStatusLaneHeader(container: HTMLElement, status: WorkspaceStatus): HTMLElement {
  const header = container.querySelector<HTMLElement>(
    `[data-workspace-status-drop-target][data-workspace-status="${status}"]`
  )
  if (!header) {
    throw new Error(`No status lane header rendered for "${status}"`)
  }
  return header
}

async function dropWorktreesOnStatusLane(
  header: HTMLElement,
  worktreeIds: readonly string[]
): Promise<void> {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: makeWorktreeIdDataTransfer(worktreeIds)
  })
  await act(async () => {
    header.dispatchEvent(event)
  })
}

function committedStatusUpdates(): Map<string, Partial<WorktreeMeta>> {
  expect(mockStore.updateWorktreesMeta).toHaveBeenCalledTimes(1)
  return mockStore.updateWorktreesMeta.mock.calls[0]![0] as Map<string, Partial<WorktreeMeta>>
}

describe('WorktreeList status-lane drop carries visible lineage children (#9083)', () => {
  beforeAll(async () => {
    WorktreeList = (await import('./WorktreeList')).default as WorktreeListComponent
  }, 60_000)

  beforeEach(() => {
    vi.clearAllMocks()
    setStatusLaneState()
  })

  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  it('moves a dragged parent and its visible lineage child to the dropped lane', async () => {
    const container = await renderWorktreeList()
    const todoHeader = findStatusLaneHeader(container, 'todo')

    // Only the parent id rides on the native drag payload; the wrapper must expand it.
    await dropWorktreesOnStatusLane(todoHeader, ['parent'])

    const updates = committedStatusUpdates()
    expect(updates.get('parent')).toEqual({ workspaceStatus: 'todo' })
    expect(updates.get('child')).toEqual({ workspaceStatus: 'todo' })
  })

  it('leaves worktrees in other lanes untouched', async () => {
    const container = await renderWorktreeList()
    const todoHeader = findStatusLaneHeader(container, 'todo')

    await dropWorktreesOnStatusLane(todoHeader, ['parent'])

    const updates = committedStatusUpdates()
    expect(updates.has('bystander')).toBe(false)
    expect(updates.size).toBe(2)
  })

  it('commits only itself when a childless worktree is dropped onto another lane', async () => {
    const container = await renderWorktreeList()
    const inProgressHeader = findStatusLaneHeader(container, 'in-progress')

    await dropWorktreesOnStatusLane(inProgressHeader, ['bystander'])

    const updates = committedStatusUpdates()
    expect(updates.get('bystander')).toEqual({
      workspaceStatus: 'in-progress'
    })
    expect(updates.has('parent')).toBe(false)
    expect(updates.has('child')).toBe(false)
    expect(updates.size).toBe(1)
  })
})
