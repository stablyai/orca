import type * as ReactModule from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
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
} from './worktree-list/listing/worktree-list-lineage-card-test-harness'
import {
  makeFolderWorkspacePathStatusMockState,
  makeFolderWorkspacePathStatusState
} from './worktree-list/listing/worktree-list-lineage-card-test-fixtures'

vi.mock('@/store', () => createAppStoreModuleMock())
vi.mock('@tanstack/react-virtual', () => createReactVirtualModuleMock())
vi.mock('@/hooks/useVirtualizedScrollAnchor', () => createVirtualizedScrollAnchorModuleMock())
vi.mock('./worktree-list/drag/project-header-drag', () => createProjectHeaderDragModuleMock())
vi.mock('./workspace-card/surface/WorktreeCard', () => createWorktreeCardModuleMock())
vi.mock('./workspace-card/activity/WorktreeCardAgents', () => createWorktreeCardAgentsModuleMock())
vi.mock('./workspace-card/identity/WorktreeTitleInlineRename', () =>
  createWorktreeTitleInlineRenameModuleMock()
)
vi.mock('./workspace-actions/context-menu/WorktreeContextMenu', () =>
  createWorktreeContextMenuModuleMock()
)
vi.mock('@/components/ui/tooltip', () => createTooltipModuleMock())
vi.mock('@/components/ui/dropdown-menu', () => createDropdownMenuModuleMock())
// Why: the list's external stores pass no server snapshot, which the static render requires.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof ReactModule>()
  return {
    ...react,
    useSyncExternalStore: <T>(
      subscribe: (onChange: () => void) => () => void,
      read: () => T,
      readOnServer: () => T = read
    ) => react.useSyncExternalStore(subscribe, read, readOnServer)
  }
})

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

  it('marks folder workspace rows as manual-sort drag slots', async () => {
    setFolderWorkspaceFixtureState()
    const markup = await renderWorktreeListMarkup()
    const optionOpeningTag =
      markup.match(
        /<div[^>]*id="worktree-list-option-local%7Cfolder%3Afolder-workspace-1"[^>]*>/
      )?.[0] ?? ''

    expect(optionOpeningTag).toContain(
      `data-worktree-drag-id="${folderWorkspaceKey('folder-workspace-1')}"`
    )
    expect(optionOpeningTag).toMatch(/data-worktree-drag-group-key="[^"]+"/)
    expect(optionOpeningTag).toContain('data-worktree-drag-group-index="0"')
  })
})
