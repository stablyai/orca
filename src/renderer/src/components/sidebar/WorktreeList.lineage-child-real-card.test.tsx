// @vitest-environment happy-dom

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn().mockResolvedValue(false)
}))

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  FLUSH_CARD_MIN_CONTENT_INSET,
  LINEAGE_CHILDREN_INLINE_OFFSET,
  LINEAGE_IMMEDIATE_PARENT_STEP,
  LINEAGE_NESTED_ROW_SURFACE_INSET,
  WORKTREE_CARD_SURFACE_MARGIN
} from './worktree-list/rows/indentation'

import { revealMountedWorktreeElement } from './worktree-list/navigation/mounted-row-reveal'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mockStore = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  setVisibleReviewCardWorktreeIds: vi.fn<(ids: readonly string[]) => void>(),
  activateWorktreeFromSidebar: vi.fn(),
  openModal: vi.fn(),
  updateWorktreeMeta: vi.fn(),
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

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mockStore.state),
    {
      getState: () => mockStore.state,
      subscribe: () => () => {}
    }
  )
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
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: ({ worktreeId }: { worktreeId: string }) => (
    <div data-agent-worktree-id={worktreeId}>Agent row</div>
  ),
  SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT: 'orca:test-suppress-scroll-adjustment'
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => (
    <div data-worktree-context-menu-scope>{children}</div>
  ),
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope',
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu'
}))

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/lineage-real-card',
    displayName: 'lineage-real-card',
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
  overrides?: Partial<Worktree>
}): Worktree {
  return {
    id: args.id,
    instanceId: args.instanceId,
    repoId: 'repo-1',
    path: `/tmp/lineage-real-card/${args.id}`,
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
    ...args.overrides
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

function makeHostedReview(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'gitlab',
    number: 42,
    title: 'Child GitLab MR',
    state: 'open',
    url: 'https://gitlab.com/acme/orca/-/merge_requests/42',
    status: 'success',
    updatedAt: '2026-06-09T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    ...overrides
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

function setLineageState(
  options: { deletingChild?: boolean; includeGrandchild?: boolean } = {}
): void {
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
    sortOrder: 10,
    overrides: {
      linkedGitLabMR: 42,
      comment: 'Child handoff note'
    }
  })
  const grandchild = makeWorktree({
    id: 'grandchild',
    instanceId: 'grandchild-instance',
    displayName: 'lineage grandchild',
    branch: 'grandchild-branch',
    sortOrder: 5
  })
  const worktrees = options.includeGrandchild ? [parent, child, grandchild] : [parent, child]
  const worktreeLineageById: Record<string, WorktreeLineage> = {
    [child.id]: makeLineage(child, parent)
  }
  if (options.includeGrandchild) {
    worktreeLineageById[grandchild.id] = makeLineage(grandchild, child)
  }
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
    deleteStateByWorktreeId: options.deletingChild
      ? { [child.id]: { isDeleting: true, error: null, canForceDelete: false } }
      : {},
    detectedWorktreesByRepo: {},
    fetchHostedReviewForBranch: mockStore.fetchHostedReviewForBranch,
    fetchIssue: mockStore.fetchIssue,
    fetchLinearIssue: mockStore.fetchLinearIssue,
    filterRepoIds: [],
    ...makeFolderWorkspacePathStatusState(),
    gitConflictOperationByWorktree: {},
    groupBy: 'none',
    hideDefaultBranchWorkspace: false,
    hostedReviewCache: {
      'local::repo-1::child-branch': {
        data: makeHostedReview(),
        fetchedAt: Date.now(),
        linkedReviewHintKey: 'gitlab:42'
      }
    },
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
    setVisibleReviewCardWorktreeIds: mockStore.setVisibleReviewCardWorktreeIds,
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
    unifiedTabsByWorktree: {},
    structuredChatSleptAtByPaneKey: {},
    terminalLayoutsByTabId: {},
    toggleCollapsedGroup: vi.fn(),
    updateRepo: vi.fn(),
    updateWorktreeMeta: mockStore.updateWorktreeMeta,
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
    worktreeLineageById,
    worktreesByRepo: {
      [repo.id]: worktrees
    }
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

function px(value: string): number {
  return value === '' ? 0 : Number.parseFloat(value)
}

function expectBoundaryStep(args: {
  wrapper: HTMLElement
  row: HTMLElement
  surface: HTMLElement
}): void {
  const effectiveStep =
    px(args.wrapper.style.marginLeft) +
    px(args.row.style.paddingLeft) +
    WORKTREE_CARD_SURFACE_MARGIN +
    px(args.surface.style.paddingLeft)

  expect(effectiveStep).toBe(LINEAGE_IMMEDIATE_PARENT_STEP)
}

describe('WorktreeList real child WorktreeCard integration', () => {
  beforeAll(async () => {
    WorktreeList = (await import('./WorktreeList')).default as WorktreeListComponent
  }, 60_000)

  beforeEach(() => {
    vi.clearAllMocks()
    setLineageState()
  })

  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  it('renders GitLab MR metadata from a child through the real WorktreeCard path', async () => {
    const container = await renderWorktreeList()
    const childOption = container.querySelector('[id="worktree-list-option-all%3A%7Cchild"]')

    expect(childOption?.textContent).toContain('MR #42')
    expect(childOption?.textContent).toContain('Child GitLab MR')
    expect(childOption?.textContent).toContain('Child handoff note')
  })

  it('keeps expanded child cards in the parent title column', async () => {
    mockStore.state.settings = { experimentalNewWorktreeCardStyle: true }
    const container = await renderWorktreeList()
    const childList = container.querySelector<HTMLElement>('[data-worktree-lineage-children]')

    expect(childList).not.toBeNull()
    expect(childList!.style.marginLeft).toBe(`${LINEAGE_CHILDREN_INLINE_OFFSET}px`)
    expect(childList!.style.width).toBe(`calc(100% - ${LINEAGE_CHILDREN_INLINE_OFFSET}px)`)
  })

  it.each([
    { newCardStyle: false, showStatus: false },
    { newCardStyle: false, showStatus: true },
    { newCardStyle: true, showStatus: false },
    { newCardStyle: true, showStatus: true }
  ])('keeps lineage outside the status lane (%j)', async ({ newCardStyle, showStatus }) => {
    setLineageState({ includeGrandchild: true })
    mockStore.state.settings = { experimentalNewWorktreeCardStyle: newCardStyle }
    mockStore.state.worktreeCardProperties = showStatus ? ['status'] : []
    const container = await renderWorktreeList()
    const wrappers = [
      ...container.querySelectorAll<HTMLElement>('[data-worktree-lineage-children]')
    ]
    const childRow = container.querySelector<HTMLElement>(
      '[id="worktree-list-option-all%3A%7Cchild"]'
    )
    const grandchildRow = container.querySelector<HTMLElement>(
      '[id="worktree-list-option-all%3A%7Cgrandchild"]'
    )
    const childSurface = childRow?.querySelector<HTMLElement>('[data-worktree-card-surface="true"]')
    const grandchildSurface = grandchildRow?.querySelector<HTMLElement>(
      '[data-worktree-card-surface="true"]'
    )

    expect(wrappers).toHaveLength(2)
    expect(childRow).not.toBeNull()
    expect(grandchildRow).not.toBeNull()
    expect(childSurface).not.toBeNull()
    expect(grandchildSurface).not.toBeNull()
    expect(px(childRow!.style.paddingLeft)).toBe(LINEAGE_NESTED_ROW_SURFACE_INSET)
    expect(px(grandchildRow!.style.paddingLeft)).toBe(LINEAGE_NESTED_ROW_SURFACE_INSET)
    expect(px(childSurface!.style.paddingLeft)).toBe(FLUSH_CARD_MIN_CONTENT_INSET)
    expect(px(grandchildSurface!.style.paddingLeft)).toBe(FLUSH_CARD_MIN_CONTENT_INSET)
    for (const wrapper of wrappers) {
      expect(wrapper.parentElement?.dataset.worktreeCardSurface).toBe('true')
      expect(wrapper.closest('[data-worktree-card-parent-content]')).toBeNull()
    }

    expectBoundaryStep({
      wrapper: wrappers[0]!,
      row: childRow!,
      surface: childSurface!
    })
    expectBoundaryStep({
      wrapper: wrappers[1]!,
      row: grandchildRow!,
      surface: grandchildSurface!
    })
  })

  it.each([
    { newStyle: false, deleting: false },
    { newStyle: true, deleting: false },
    { newStyle: true, deleting: true }
  ])('reveals complete real-card segments %j', async ({ newStyle, deleting }) => {
    setLineageState({ includeGrandchild: true, deletingChild: deleting })
    mockStore.state.settings = { experimentalNewWorktreeCardStyle: newStyle }
    const container = await renderWorktreeList()
    const parent = container.querySelector<HTMLElement>(
      '[role="option"][data-worktree-id="parent"]'
    )!
    const child = container.querySelector<HTMLElement>('[role="option"][data-worktree-id="child"]')!
    const boundaries = container.querySelectorAll<HTMLElement>('[data-worktree-lineage-children]')
    Object.defineProperty(container, 'clientHeight', { value: 673 })
    container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 673)
    parent.getBoundingClientRect = () => new DOMRect(0, 200, 300, 11800)
    child.getBoundingClientRect = () => new DOMRect(0, 900, 300, 11100)
    boundaries[0]!.getBoundingClientRect = () => new DOMRect(0, 320, 300, 11680)
    boundaries[1]!.getBoundingClientRect = () => new DOMRect(0, 1020, 300, 10980)
    container.scrollTo = vi.fn()

    expect(revealMountedWorktreeElement(container, 'parent', 'auto', parent.id)).toBe(parent)
    expect(container.scrollTo).not.toHaveBeenCalled()
    expect(revealMountedWorktreeElement(container, 'child', 'auto', child.id)).toBe(child)
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 347, behavior: 'auto' })
    const leaf = container.querySelector<HTMLElement>('[data-worktree-id="grandchild"]')!
    leaf.getBoundingClientRect = () => new DOMRect(0, 1005, 300, 55)
    expect(revealMountedWorktreeElement(container, 'grandchild', 'auto', leaf.id)).toBe(leaf)
    expect(container.scrollTo).toHaveBeenLastCalledWith({ top: 387, behavior: 'auto' })
    expect(parent.getBoundingClientRect().height).toBe(11800)
    if (newStyle && !deleting) {
      expect(parent.querySelector('[data-worktree-sleeping-dim]')).not.toBeNull()
    }
    if (deleting) {
      expect(child.querySelector('[aria-busy=true]')).not.toBeNull()
    }
    expect(boundaries[0]!.parentElement?.lastElementChild).toBe(boundaries[0])
  })

  it('double-clicking a nested child opens edit metadata for the child only', async () => {
    const container = await renderWorktreeList()
    const childCard = container.querySelector<HTMLElement>(
      '[id="worktree-list-option-all%3A%7Cchild"] [data-worktree-card-surface="true"]'
    )

    expect(childCard).not.toBeNull()
    await act(async () => {
      childCard!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    expect(mockStore.openModal).toHaveBeenCalledTimes(1)
    expect(mockStore.openModal).toHaveBeenCalledWith(
      'edit-meta',
      expect.objectContaining({
        worktreeId: 'child',
        currentDisplayName: 'lineage child',
        currentComment: 'Child handoff note'
      })
    )
    expect(mockStore.openModal).not.toHaveBeenCalledWith(
      'edit-meta',
      expect.objectContaining({ worktreeId: 'parent' })
    )
  })

  it.each([
    { pressed: 'option', worktreeId: 'parent' },
    { pressed: 'option', worktreeId: 'child' },
    { pressed: 'option', worktreeId: 'folder:folder-workspace' },
    { pressed: 'card', worktreeId: 'parent' },
    { pressed: 'card', worktreeId: 'child' },
    { pressed: 'card', worktreeId: 'folder:folder-workspace' }
  ])('activating the $worktreeId $pressed activates it once', async ({ pressed, worktreeId }) => {
    mockStore.state.projectGroups = [
      {
        id: 'folder-group',
        name: 'Folder group',
        parentPath: '/tmp/lineage-real-card-folder',
        parentGroupId: null,
        createdFrom: 'folder-scan',
        tabOrder: 1,
        isCollapsed: false,
        color: null,
        createdAt: 1,
        updatedAt: 1
      }
    ] satisfies ProjectGroup[]
    mockStore.state.folderWorkspaces = [
      {
        id: 'folder-workspace',
        projectGroupId: 'folder-group',
        name: 'folder workspace',
        folderPath: '/tmp/lineage-real-card-folder',
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
    ] satisfies FolderWorkspace[]
    const container = await renderWorktreeList()
    const option = container.querySelector<HTMLElement>(
      `[role="option"][data-worktree-id="${worktreeId}"]`
    )
    const target =
      pressed === 'option'
        ? option
        : option?.querySelector<HTMLElement>('[data-worktree-card-surface="true"]')

    expect(target).not.toBeNull()
    await act(async () => {
      target!.click()
    })

    if (pressed === 'option' && worktreeId === 'folder:folder-workspace') {
      container.getBoundingClientRect = () => new DOMRect(0, 0, 300, 673)
      Object.defineProperty(container, 'clientHeight', { value: 673 })
      option!.getBoundingClientRect = () => new DOMRect(0, 1005, 300, 55)
      container.scrollTo = vi.fn()
      expect(revealMountedWorktreeElement(container, worktreeId, 'auto', option!.id)).toBe(option)
      expect(container.scrollTo).toHaveBeenCalledWith({ top: 387, behavior: 'auto' })
    }

    expect(mockStore.activateWorktreeFromSidebar).toHaveBeenCalledTimes(1)
    expect(mockStore.activateWorktreeFromSidebar).toHaveBeenCalledWith(worktreeId, 'local')
  })

  it('does not activate a nested child while it is deleting', async () => {
    setLineageState({ deletingChild: true })
    const container = await renderWorktreeList()
    const childCard = container.querySelector<HTMLElement>(
      '[id="worktree-list-option-all%3A%7Cchild"] [data-worktree-card-surface="true"]'
    )

    expect(childCard?.textContent).toContain('Deleting')
    await act(async () => {
      childCard!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mockStore.activateWorktreeFromSidebar).not.toHaveBeenCalled()
  })
})
