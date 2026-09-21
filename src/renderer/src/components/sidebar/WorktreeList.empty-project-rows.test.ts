import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
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
  makeRepo
} from './worktree-list-lineage-card-test-fixtures'

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

function setEmptyUngroupedProjectState(filterRepoIds: string[] = []): void {
  const repo: Repo = {
    ...makeRepo(),
    displayName: 'empty-project'
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
    collapsedGroups: new Set<string>(),
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
    projectGroups: [],
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

  it('does not render the collapse affordance on empty ungrouped projects', async () => {
    setEmptyUngroupedProjectState()
    const markup = await renderWorktreeListMarkup()

    expect(markup).not.toContain('data-repo-header-collapse-affordance=""')
  })

  it('renders an empty ungrouped project instead of the empty workspace state', async () => {
    setEmptyUngroupedProjectState()
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('empty-project')
    expect(markup).not.toContain('No workspaces found')
  })

  it('shows Clear Filters when repo filters exclude an empty ungrouped project', async () => {
    setEmptyUngroupedProjectState(['another-repo'])
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('No workspaces found')
    expect(markup).toContain('Clear Filters')
    expect(markup).not.toContain('empty-project')
  })
})
