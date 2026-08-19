import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
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
} from './worktree-list-lineage-card-test-harness'
import {
  makeFolderWorkspacePathStatusMockState,
  makeFolderWorkspacePathStatusState
} from './worktree-list-lineage-card-test-fixtures'
import {
  getCardOpeningTag,
  getDataNumber,
  getFlushCardContentStart,
  getFolderWorkspaceSurfaceOpeningTag,
  getPaddingLeft
} from './worktree-list-card-markup-queries'

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

function setFolderWorkspaceFixtureState(
  options: {
    createdFrom?: ProjectGroup['createdFrom']
    experimentalNewWorktreeCardStyle?: boolean
    nestedGroup?: boolean
  } = {}
): void {
  const parentGroup: ProjectGroup | null = options.nestedGroup
    ? {
        id: 'folder-parent-group-1',
        name: 'Parent Folder Group',
        parentPath: '/tmp/lineage-order',
        parentGroupId: null,
        createdFrom: 'folder-scan',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 1,
        updatedAt: 1
      }
    : null
  const group: ProjectGroup = {
    id: 'folder-group-1',
    name: 'Folder Group',
    parentPath: '/tmp/lineage-order/folder',
    parentGroupId: parentGroup?.id ?? null,
    createdFrom: options.createdFrom ?? 'folder-scan',
    tabOrder: parentGroup ? 1 : 0,
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
    projectGroups: parentGroup ? [parentGroup, group] : [group],
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
    settings: options.experimentalNewWorktreeCardStyle
      ? { experimentalNewWorktreeCardStyle: true }
      : null,
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
}

// Why: describe title is shared across the split files so test full names stay stable.
describe('WorktreeList lineage child card renderer', () => {
  beforeAll(async () => {
    await loadWorktreeList()
  }, 60_000)

  it('points aria-activedescendant at the active folder workspace row', async () => {
    setFolderWorkspaceFixtureState()
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain(
      'aria-activedescendant="worktree-list-option-folder%3Afolder-workspace-1"'
    )
  })

  it('keeps folder workspace cards one compact step under their group header', async () => {
    setFolderWorkspaceFixtureState()
    const markup = await renderWorktreeListMarkup()
    const folderWorktreeId = folderWorkspaceKey('folder-workspace-1')
    const cardOpeningTag = getCardOpeningTag(markup, folderWorktreeId)
    const surfaceOpeningTag = getFolderWorkspaceSurfaceOpeningTag(markup, 'folder-workspace-1')
    const cardContentIndent = getDataNumber(cardOpeningTag, 'data-content-indent')

    expect(cardOpeningTag).toContain('data-content-indent="6"')
    expect(cardOpeningTag).toContain('data-flush-surface="true"')
    expect(
      getFlushCardContentStart({
        cardContentIndent,
        surfaceInset: getPaddingLeft(surfaceOpeningTag)
      })
    ).toBe(20)
  })

  it('uses comparable new-card worktree geometry for experimental folder workspace rows', async () => {
    setFolderWorkspaceFixtureState({ experimentalNewWorktreeCardStyle: true })
    const markup = await renderWorktreeListMarkup()
    const folderWorktreeId = folderWorkspaceKey('folder-workspace-1')
    const cardOpeningTag = getCardOpeningTag(markup, folderWorktreeId)
    const surfaceOpeningTag = getFolderWorkspaceSurfaceOpeningTag(markup, 'folder-workspace-1')
    const cardContentIndent = getDataNumber(cardOpeningTag, 'data-content-indent')

    expect(surfaceOpeningTag).toContain('padding-left:14px')
    expect(cardOpeningTag).toContain('data-content-indent="16"')
    expect(cardOpeningTag).toContain('data-flush-surface="true"')
    expect(
      getFlushCardContentStart({
        cardContentIndent,
        surfaceInset: getPaddingLeft(surfaceOpeningTag)
      })
    ).toBe(30)
  })

  it('preserves manual folder workspace indentation outside folder-scanned groups', async () => {
    setFolderWorkspaceFixtureState({ createdFrom: 'manual' })
    const markup = await renderWorktreeListMarkup()
    const folderWorktreeId = folderWorkspaceKey('folder-workspace-1')
    const cardOpeningTag = getCardOpeningTag(markup, folderWorktreeId)
    const surfaceOpeningTag = getFolderWorkspaceSurfaceOpeningTag(markup, 'folder-workspace-1')
    const cardContentIndent = getDataNumber(cardOpeningTag, 'data-content-indent')

    expect(cardOpeningTag).toContain('data-content-indent="24"')
    expect(
      getFlushCardContentStart({
        cardContentIndent,
        surfaceInset: getPaddingLeft(surfaceOpeningTag)
      })
    ).toBe(38)
  })

  it('caps nested folder workspace surfaces to keep compact final anchors', async () => {
    setFolderWorkspaceFixtureState({ nestedGroup: true })
    const markup = await renderWorktreeListMarkup()
    const folderWorktreeId = folderWorkspaceKey('folder-workspace-1')
    const cardOpeningTag = getCardOpeningTag(markup, folderWorktreeId)
    const surfaceOpeningTag = getFolderWorkspaceSurfaceOpeningTag(markup, 'folder-workspace-1')
    const cardContentIndent = getDataNumber(cardOpeningTag, 'data-content-indent')

    expect(surfaceOpeningTag).toContain('padding-left:24px')
    expect(cardOpeningTag).toContain('data-content-indent="6"')
    expect(
      getFlushCardContentStart({
        cardContentIndent,
        surfaceInset: getPaddingLeft(surfaceOpeningTag)
      })
    ).toBe(30)
  })
})
