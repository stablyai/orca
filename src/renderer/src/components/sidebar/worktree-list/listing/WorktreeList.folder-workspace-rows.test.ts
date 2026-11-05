import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
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
  makeFolderWorkspacePathStatusState
} from './worktree-list-lineage-card-test-fixtures'

vi.mock('@/store', () => createAppStoreModuleMock())
vi.mock('@tanstack/react-virtual', () => createReactVirtualModuleMock())
vi.mock('@/hooks/useVirtualizedScrollAnchor', () => createVirtualizedScrollAnchorModuleMock())
vi.mock('../drag/project-header-drag', () => createProjectHeaderDragModuleMock())
vi.mock('../../workspace-card/surface/WorktreeCard', () => createWorktreeCardModuleMock())
vi.mock('../../workspace-card/activity/WorktreeCardAgents', () =>
  createWorktreeCardAgentsModuleMock()
)
vi.mock('../../workspace-card/identity/WorktreeTitleInlineRename', () =>
  createWorktreeTitleInlineRenameModuleMock()
)
vi.mock('../../workspace-actions/context-menu/WorktreeContextMenu', () =>
  createWorktreeContextMenuModuleMock()
)
vi.mock('@/components/ui/tooltip', () => createTooltipModuleMock())
vi.mock('@/components/ui/dropdown-menu', () => createDropdownMenuModuleMock())

function makeFolderWorkspace(
  groupId: string,
  overrides: Partial<FolderWorkspace> = {}
): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: groupId,
    name: 'Folder workspace fixture',
    folderPath: '/tmp/lineage-order/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function setFolderWorkspaceFixtureState() {
  const group: ProjectGroup = {
    id: 'folder-group-1',
    name: 'Folder Group',
    parentPath: '/tmp/lineage-order/folder',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
  const folderWorkspace = makeFolderWorkspace(group.id)

  mockStore.state = {
    ...makeFolderWorkspacePathStatusMockState(),
    activeModal: '',
    activeView: 'terminal',
    activeWorktreeId: folderWorkspaceKey(folderWorkspace.id),
    agentStatusEpoch: 0,
    agentStatusByPaneKey: {},
    browserTabsByWorktree: {},
    clearPendingRevealWorktreeId: vi.fn(),
    collapsedGroups: new Set<string>(),
    deleteStateByWorktreeId: {},
    filterRepoIds: [],
    ...makeFolderWorkspacePathStatusState(),
    folderWorkspaces: [folderWorkspace],
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
    repos: [],
    runtimePaneTitlesByTabId: {},
    setFilterRepoIds: vi.fn(),
    setHideDefaultBranchWorkspace: vi.fn(),
    setRenamingWorktreeId: vi.fn(),
    setShowSleepingWorkspaces: vi.fn(),
    setSortBy: vi.fn(),
    settings: null,
    renamingWorktreeId: null,
    showSleepingWorkspaces: true,
    sortBy: 'manual',
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
    worktreesByRepo: {}
  }
  return { folderWorkspace, group }
}

describe('WorktreeList lineage child card renderer', () => {
  beforeAll(async () => {
    await loadWorktreeList()
  }, 60_000)

  it.each(['runtime:host-a', 'runtime:host-b'] as const)(
    'marks only the selected folder host %s as active',
    async (selectedHost) => {
      const { folderWorkspace, group } = setFolderWorkspaceFixtureState()
      const hosts = ['runtime:host-a', 'runtime:host-b'] as const
      mockStore.state.folderWorkspaces = hosts.map((executionHostId) => ({
        ...folderWorkspace,
        executionHostId,
        projectGroupId: executionHostId,
        name: executionHostId
      }))
      mockStore.state.projectGroups = hosts.map((executionHostId) => ({
        ...group,
        id: executionHostId,
        executionHostId
      }))
      mockStore.state.activeWorkspaceExecutionHostId = selectedHost
      const markup = await renderWorktreeListMarkup()
      const options = Array.from(markup.matchAll(/<div[^>]*role="option"[^>]*>/g), ([tag]) => tag)
      expect(options).toHaveLength(2)
      const active = options.filter((tag) => tag.includes('aria-current="page"'))
      expect(active).toHaveLength(1)
      expect(active[0]).toContain(`data-worktree-host-identity="${selectedHost}|folder:`)
      expect(markup.match(/data-worktree-card-active="true"/g)).toHaveLength(1)
    }
  )

  it('points aria-activedescendant at the active folder workspace row', async () => {
    setFolderWorkspaceFixtureState()
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain(
      'aria-activedescendant="worktree-list-option-local%7Cfolder%3Afolder-workspace-1"'
    )
  })
})
