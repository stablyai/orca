import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { getPinnedWorktreeRevealCollapsedGroupKeys } from './worktree-list/navigation/reveal-ancestors'
import {
  createAppStoreModuleMock,
  createDropdownMenuModuleMock,
  createProjectHeaderDragModuleMock,
  createReactVirtualModuleMock,
  createTooltipModuleMock,
  createVirtualizedScrollAnchorModuleMock,
  createWorktreeCardAgentsModuleMock,
  createWorktreeCardModuleMock,
  createWorktreeContextMenuModuleMock,
  createWorktreeTitleInlineRenameModuleMock,
  loadWorktreeList,
  mockStore,
  renderWorktreeListMarkup
} from './worktree-list-lineage-card-test-harness'
import {
  makeFolderWorkspacePathStatusMockState,
  makeFolderWorkspacePathStatusState,
  makeRepo,
  makeWorktree
} from './worktree-list-lineage-card-test-fixtures'
import { setLineageFixtureState } from './worktree-list-lineage-store-state'
import { setPinnedFixtureState } from './worktree-list-pinned-store-state'

vi.mock('@/store', () => createAppStoreModuleMock())
vi.mock('@tanstack/react-virtual', () => createReactVirtualModuleMock())
vi.mock('@/hooks/useVirtualizedScrollAnchor', () => createVirtualizedScrollAnchorModuleMock())
vi.mock('./project-header-drag', () => createProjectHeaderDragModuleMock())
vi.mock('./WorktreeCard', () => createWorktreeCardModuleMock())
vi.mock('./WorktreeCardAgents', () => createWorktreeCardAgentsModuleMock())
vi.mock('./WorktreeTitleInlineRename', () => createWorktreeTitleInlineRenameModuleMock())
vi.mock('./WorktreeContextMenu', () => createWorktreeContextMenuModuleMock())
vi.mock('@/components/ui/tooltip', () => createTooltipModuleMock())
vi.mock('@/components/ui/dropdown-menu', () => createDropdownMenuModuleMock())

function setProjectGroupWithoutWorktreeRowsState(
  filterRepoIds: string[] = [],
  collapsedGroups = new Set<string>()
): void {
  const group: ProjectGroup = {
    id: 'group-1',
    name: 'Imported Services',
    parentPath: '/tmp/imported-services',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
  const repo: Repo = {
    ...makeRepo(),
    projectGroupId: group.id
  }

  mockStore.state = {
    ...makeFolderWorkspacePathStatusMockState(),
    activeModal: '',
    activeView: 'terminal',
    activeWorktreeId: null,
    agentStatusEpoch: 0,
    agentStatusByPaneKey: {},
    browserTabsByWorktree: {},
    clearPendingRevealWorktreeId: vi.fn(),
    collapsedGroups,
    deleteStateByWorktreeId: {},
    filterRepoIds,
    ...makeFolderWorkspacePathStatusState(),
    groupBy: 'repo',
    hideDefaultBranchWorkspace: false,
    issueCache: {},
    migrationUnsupportedByPtyId: {},
    openModal: vi.fn(),
    pendingRevealWorktree: null,
    prCache: {},
    prVisibleRefreshGeneration: 0,
    projectGroups: [group],
    ptyIdsByTabId: {},
    reorderRepos: vi.fn(),
    reportVisibleGitHubPRRefreshCandidates: vi.fn(),
    retainedAgentsByPaneKey: {},
    repos: [repo],
    runtimePaneTitlesByTabId: {},
    setFilterRepoIds: vi.fn(),
    setHideDefaultBranchWorkspace: vi.fn(),
    setRenamingWorktreeId: vi.fn(),
    setShowSleepingWorkspaces: vi.fn(),
    setSortBy: vi.fn(),
    settings: null,
    renamingWorktreeId: null,
    showSleepingWorkspaces: true,
    sortBy: 'recent',
    sortEpoch: 0,
    sshConnectedGeneration: 0,
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    toggleCollapsedGroup: vi.fn(),
    updateWorktreeMeta: vi.fn(),
    updateWorktreesMeta: vi.fn(),
    workspaceHostScope: 'all',
    workspaceStatuses: [],
    worktreeCardProperties: ['status', 'inline-agents'],
    worktreeLineageById: {},
    worktreesByRepo: {
      [repo.id]: []
    }
  }
}

// Why: describe title is shared across the split files so test full names stay stable.
describe('WorktreeList lineage child card renderer', () => {
  beforeAll(async () => {
    await loadWorktreeList()
  }, 60_000)

  it('renders project group headers when repos import before worktree rows load', async () => {
    setProjectGroupWithoutWorktreeRowsState()
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('Imported Services')
    expect(markup).not.toContain('No workspaces found')
  })

  it('renders a collapse chevron on project group headers with children', async () => {
    setProjectGroupWithoutWorktreeRowsState()
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('data-repo-header-collapse-affordance=""')
    expect(markup).toContain('aria-expanded="true"')
  })

  it('renders collapsed project group header affordance state', async () => {
    setProjectGroupWithoutWorktreeRowsState([], new Set(['project-group:group-1']))
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('data-repo-header-collapse-affordance=""')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('-rotate-90')
  })

  it('does not render the project collapse affordance on flat section headers', async () => {
    setLineageFixtureState('none')
    const markup = await renderWorktreeListMarkup()

    expect(markup).not.toContain('data-repo-header-collapse-affordance=""')
  })

  it('uncollapses pinned reveal for a descendant that only lives under a pinned parent', () => {
    const child = makeWorktree({
      id: 'child-of-pinned',
      instanceId: 'child-of-pinned-instance',
      displayName: 'Child of pinned',
      branch: 'child',
      sortOrder: 2
    })

    expect(
      getPinnedWorktreeRevealCollapsedGroupKeys({
        worktree: child,
        collapsedGroups: new Set(['pinned', 'all']),
        inPinnedSection: true
      })
    ).toEqual(['pinned'])
  })

  it('uncollapses pinned reveal through the pinned section after host expansion', () => {
    const worktree = makeWorktree({
      id: 'pinned-ssh',
      instanceId: 'pinned-ssh-instance',
      displayName: 'Pinned SSH workspace',
      branch: 'pinned-ssh',
      sortOrder: 1
    })
    worktree.isPinned = true

    expect(
      getPinnedWorktreeRevealCollapsedGroupKeys({
        worktree,
        collapsedGroups: new Set(['host:ssh:builder-1', 'pinned', 'done'])
      })
    ).toEqual(['pinned'])
  })

  it('renders a collapse chevron on status group headers with worktrees', async () => {
    setLineageFixtureState('workspace-status')
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('In progress')
    expect(markup).toContain('data-workspace-status-drop-target=""')
    expect(markup).toContain('data-repo-header-collapse-affordance=""')
    expect(markup).toContain('aria-expanded="true"')
  })

  it('renders a collapse chevron on the pinned section header with worktrees', async () => {
    setPinnedFixtureState()
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('Pinned')
    expect(markup).toContain('data-workspace-pin-drop-target=""')
    expect(markup).toContain('data-repo-header-collapse-affordance=""')
    expect(markup).toContain('aria-expanded="true"')
  })

  it('renders collapsed pinned section header affordance state', async () => {
    setPinnedFixtureState()
    mockStore.state = {
      ...mockStore.state,
      collapsedGroups: new Set(['pinned'])
    }
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('data-workspace-pin-drop-target=""')
    expect(markup).toContain('data-repo-header-collapse-affordance=""')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('-rotate-90')
  })

  it('renders a collapse chevron on grouped repo headers with worktrees', async () => {
    setLineageFixtureState('repo')
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('data-repo-header-collapse-affordance=""')
    expect(markup).toContain('data-repo-header-id="repo-1"')
    expect(markup).toContain('aria-expanded="true"')
  })

  it('shows Clear Filters when filters exclude pre-worktree project groups', async () => {
    setProjectGroupWithoutWorktreeRowsState(['another-repo'])
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('No workspaces found')
    expect(markup).toContain('Clear Filters')
    expect(markup).not.toContain('Imported Services')
  })
})
