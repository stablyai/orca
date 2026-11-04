// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
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
import {
  getCardOpeningTag,
  getDataNumber,
  getFlushCardContentStart,
  getFolderWorkspaceSurfaceOpeningTag,
  getPaddingLeft
} from '../viewport/worktree-list-card-markup-queries'

const createMocks = vi.hoisted(() => ({ activateAndRevealFolderWorkspace: vi.fn() }))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: createMocks.activateAndRevealFolderWorkspace
}))

vi.mock('@/store', () => createAppStoreModuleMock())
vi.mock('@tanstack/react-virtual', () => createReactVirtualModuleMock())
vi.mock('@/hooks/useVirtualizedScrollAnchor', () => createVirtualizedScrollAnchorModuleMock())
vi.mock('../drag/project-header-drag', () => createProjectHeaderDragModuleMock())
vi.mock('../../workspace-card/surface/WorktreeCard', () => createWorktreeCardModuleMock())
vi.mock('../../workspace-card/activity/WorktreeCardAgents', () => ({
  ...createWorktreeCardAgentsModuleMock(),
  SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT: 'orca:test-suppress-scroll-adjustment'
}))
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

function setFolderWorkspaceFixtureState(
  options: {
    createdFrom?: ProjectGroup['createdFrom']
    experimentalNewWorktreeCardStyle?: boolean
    nestedGroup?: boolean
  } = {}
) {
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

  it('creates directly in the clicked folder project while a git worktree is current', async () => {
    const { group } = setFolderWorkspaceFixtureState()
    const createdWorkspace = makeFolderWorkspace(group.id, { id: 'new-folder-workspace' })
    const createFolderWorkspace = vi.fn().mockResolvedValue(createdWorkspace)
    mockStore.state.createFolderWorkspace = createFolderWorkspace
    mockStore.state.setVisibleReviewCardWorktreeIds = vi.fn()
    mockStore.state.activeWorkspaceKey = 'worktree:current-git-worktree'
    mockStore.state.activeWorktreeId = 'current-git-worktree'
    const { default: WorktreeList } = await import('./WorktreeList')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    try {
      act(() => {
        root.render(
          React.createElement(
            ConfirmationDialogContext.Provider,
            { value: async () => false },
            React.createElement(WorktreeList, {
              scrollOffsetRef: { current: 0 },
              scrollAnchorRef: { current: null }
            })
          )
        )
      })
      const button = container.querySelector<HTMLButtonElement>(
        '[aria-label="Create workspace for Folder Group"]'
      )
      expect(button).not.toBeNull()
      await act(async () => button!.click())

      expect(createFolderWorkspace).toHaveBeenCalledWith(
        {
          projectGroupId: group.id,
          name: 'Folder Group workspace',
          connectionId: null,
          linkedTask: null
        },
        { runtimeEnvironmentId: null }
      )
      expect(createMocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
        createdWorkspace.id,
        { agent: null, runtimeEnvironmentId: null }
      )
      expect(mockStore.state.openModal).not.toHaveBeenCalled()
    } finally {
      act(() => root.unmount())
      container.remove()
    }
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
