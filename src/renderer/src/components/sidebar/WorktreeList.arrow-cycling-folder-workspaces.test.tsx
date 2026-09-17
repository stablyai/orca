// @vitest-environment happy-dom

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn().mockResolvedValue(false)
}))

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mockStore = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  activateWorktreeFromSidebar: vi.fn(),
  activateAndRevealWorkspace: vi.fn(),
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

// Why: pin the platform so the chord below is deterministic instead of depending on the test env's userAgent.
vi.mock('@/lib/shortcut-platform', () => ({
  getShortcutPlatform: () => 'darwin'
}))

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
  activateAndRevealWorkspace: mockStore.activateAndRevealWorkspace
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
    return <div data-mock-worktree-card={worktree.id} />
  })
  return { default: MockWorktreeCard }
})

const REPO_ID = 'repo-1'
const FOLDER_WORKSPACE_ID = 'folder-1'
const FOLDER_WORKSPACE_KEY = folderWorkspaceKey(FOLDER_WORKSPACE_ID)

function makeRepo(): Repo {
  return {
    id: REPO_ID,
    path: '/tmp/arrow-cycling',
    displayName: 'arrow-cycling',
    badgeColor: '#999999',
    addedAt: 1
  }
}

function makeWorktree(id: string, sortOrder: number): Worktree {
  return {
    id,
    instanceId: `${id}-instance`,
    repoId: REPO_ID,
    path: `/tmp/arrow-cycling/${id}`,
    displayName: id,
    branch: `${id}-branch`,
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
    sortOrder,
    lastActivityAt: sortOrder
  }
}

function makeProjectGroup(): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Group 1',
    parentPath: '/tmp/arrow-cycling-group',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeFolderWorkspace(): FolderWorkspace {
  return {
    id: FOLDER_WORKSPACE_ID,
    projectGroupId: 'group-1',
    name: 'Folder 1',
    folderPath: '/tmp/arrow-cycling-group/folder-1',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

// Why split: the store tracks a folder workspace through activeWorkspaceKey, leaving
// activeWorktreeId null — feeding the `folder:` key to both would not be a real state.
function activeWorkspaceState(workspaceId: string | null): {
  activeWorkspaceKey: string | null
  activeWorktreeId: string | null
} {
  if (workspaceId !== null && parseWorkspaceKey(workspaceId)?.type === 'folder') {
    return { activeWorkspaceKey: workspaceId, activeWorktreeId: null }
  }
  return { activeWorkspaceKey: null, activeWorktreeId: workspaceId }
}

function setSidebarState(activeWorkspaceId: string | null): void {
  const repo = makeRepo()
  mockStore.state = {
    fetchFolderWorkspacePathStatus: vi.fn(),
    folderWorkspacePathStatuses: {},
    folderWorkspaces: [makeFolderWorkspace()],
    getFolderWorkspacePathStatusCacheKey: (request: unknown) => JSON.stringify(request),
    getFreshFolderWorkspacePathStatus: vi.fn(() => null),
    // Why 'none': the keydown handler bails on any open modal.
    activeModal: 'none',
    activeView: 'terminal',
    ...activeWorkspaceState(activeWorkspaceId),
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
    // Why 'repo': buildRows only emits project-group and folder-workspace rows in this grouping mode.
    groupBy: 'repo',
    hideDefaultBranchWorkspace: false,
    hostedReviewCache: {},
    issueCache: {},
    keybindings: undefined,
    linearIssueCache: {},
    linearStatus: null,
    migrationUnsupportedByPtyId: {},
    openModal: mockStore.openModal,
    openSettingsPage: vi.fn(),
    openSettingsTarget: null,
    openTaskPage: vi.fn(),
    pendingRevealWorktree: null,
    prCache: {},
    projectGroups: [makeProjectGroup()],
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
    worktreeNavHistory: [],
    worktreeNavHistoryIndex: -1,
    worktreesByRepo: {
      [REPO_ID]: [makeWorktree('wt-a', 20), makeWorktree('wt-b', 10)]
    }
  }
}

const mountedRoots: Root[] = []

async function renderList(root: Root): Promise<void> {
  await act(async () => {
    root.render(
      <WorktreeList scrollOffsetRef={{ current: 0 }} scrollAnchorRef={{ current: null }} />
    )
  })
}

async function pressCycle(root: Root, direction: 'up' | 'down'): Promise<string | null> {
  mockStore.activateAndRevealWorkspace.mockClear()
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: direction === 'down' ? 'ArrowDown' : 'ArrowUp',
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    )
  })
  const target = mockStore.activateAndRevealWorkspace.mock.calls.at(-1)?.[0] ?? null
  if (typeof target === 'string') {
    // Why: activation is mocked, so advance the selection by hand to let the next press continue.
    mockStore.state = { ...mockStore.state, ...activeWorkspaceState(target) }
    await renderList(root)
    return target
  }
  return null
}

async function collectCycle(root: Root, direction: 'up' | 'down', steps: number) {
  const visited: string[] = []
  for (let i = 0; i < steps; i++) {
    const target = await pressCycle(root, direction)
    if (target === null) {
      break
    }
    visited.push(target)
  }
  return visited
}

describe('arrow cycling covers folder workspaces', () => {
  beforeAll(async () => {
    WorktreeList = (await import('./WorktreeList')).default as WorktreeListComponent
  }, 60_000)

  beforeEach(() => {
    vi.clearAllMocks()
    setSidebarState('wt-a')
  })

  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  async function mount(): Promise<Root> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mountedRoots.push(root)
    await renderList(root)
    return root
  }

  it('reaches the folder workspace when cycling down', async () => {
    const root = await mount()
    const visited = await collectCycle(root, 'down', 4)

    expect(visited).toContain(FOLDER_WORKSPACE_KEY)
    // Every sidebar row is reachable, so a full lap visits all three workspaces.
    expect(new Set(visited)).toEqual(new Set(['wt-a', 'wt-b', FOLDER_WORKSPACE_KEY]))
  })

  it('reaches the folder workspace when cycling up', async () => {
    const root = await mount()
    const visited = await collectCycle(root, 'up', 4)

    expect(visited).toContain(FOLDER_WORKSPACE_KEY)
  })

  it('steps off the folder workspace instead of getting stuck on it', async () => {
    setSidebarState(FOLDER_WORKSPACE_KEY)
    const root = await mount()

    const target = await pressCycle(root, 'down')

    expect(target).not.toBe(FOLDER_WORKSPACE_KEY)
    expect(['wt-a', 'wt-b']).toContain(target)
  })
})
