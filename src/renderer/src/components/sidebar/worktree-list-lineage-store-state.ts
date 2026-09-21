import { vi } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import { mockStore } from './worktree-list-lineage-card-test-harness'
import {
  makeFolderWorkspacePathStatusMockState,
  makeFolderWorkspacePathStatusState,
  makeRepo,
  makeWorktree
} from './worktree-list-lineage-card-test-fixtures'

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

export function setLineageFixtureState(
  groupBy: 'none' | 'repo' | 'workspace-status' = 'none',
  options: {
    childWorktreeOverrides?: Partial<Worktree>
    deletingWorktreeIds?: string[]
    folderBackedProjectGroup?: boolean
    projectGroupDepth?: number
    projectGrouped?: boolean
    unreadWorktreeIds?: string[]
  } = {}
): void {
  const projectGroupDepth = Math.max(0, Math.floor(options.projectGroupDepth ?? 0))
  const parentProjectGroups: ProjectGroup[] = Array.from(
    { length: projectGroupDepth },
    (_, index) => ({
      id: `project-group-parent-${index + 1}`,
      name: `Parent ${index + 1}`,
      parentPath: `/tmp/lineage-order/parent-${index + 1}`,
      parentGroupId: index === 0 ? null : `project-group-parent-${index}`,
      createdFrom: options.folderBackedProjectGroup ? 'folder-scan' : 'manual',
      tabOrder: index,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    })
  )
  const projectGroup: ProjectGroup = {
    id: 'project-group-1',
    name: 'Personal',
    parentPath: '/tmp/lineage-order',
    parentGroupId: projectGroupDepth > 0 ? `project-group-parent-${projectGroupDepth}` : null,
    createdFrom: options.folderBackedProjectGroup ? 'folder-scan' : 'manual',
    tabOrder: projectGroupDepth,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
  const repo = {
    ...makeRepo(),
    projectGroupId: options.projectGrouped ? projectGroup.id : null
  }
  const parent = makeWorktree({
    id: 'parent',
    instanceId: 'parent-instance',
    displayName: 'lineage parent',
    branch: 'parent-branch',
    sortOrder: 30
  })
  const child = makeWorktree({
    id: 'child',
    instanceId: 'child-instance',
    displayName: 'lineage child with agent',
    branch: 'child-branch',
    sortOrder: 20
  })
  Object.assign(child, options.childWorktreeOverrides)
  const grandchild = makeWorktree({
    id: 'grandchild',
    instanceId: 'grandchild-instance',
    displayName: 'lineage grandchild',
    branch: 'grandchild-branch',
    sortOrder: 10
  })
  const unreadWorktreeIds = new Set(options.unreadWorktreeIds ?? [])
  parent.isUnread = unreadWorktreeIds.has(parent.id)
  child.isUnread = unreadWorktreeIds.has(child.id)
  grandchild.isUnread = unreadWorktreeIds.has(grandchild.id)

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
    deleteStateByWorktreeId: Object.fromEntries(
      (options.deletingWorktreeIds ?? []).map((worktreeId) => [
        worktreeId,
        { isDeleting: true, error: null, canForceDelete: false }
      ])
    ),
    filterRepoIds: [],
    ...makeFolderWorkspacePathStatusState(),
    groupBy,
    hideDefaultBranchWorkspace: false,
    issueCache: {},
    migrationUnsupportedByPtyId: {},
    openModal: vi.fn(),
    pendingRevealWorktree: null,
    prCache: {},
    prVisibleRefreshGeneration: 0,
    projectGroups: options.projectGrouped ? [...parentProjectGroups, projectGroup] : [],
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
    // Why: multi-host added a host scope filter; 'all' (the store default)
    // bypasses it so the fixture's worktrees aren't dropped before rendering.
    workspaceHostScope: 'all',
    workspaceStatuses: groupBy === 'workspace-status' ? cloneDefaultWorkspaceStatuses() : [],
    worktreeCardProperties: ['status', 'inline-agents'],
    worktreeLineageById: {
      [child.id]: makeLineage(child, parent),
      [grandchild.id]: makeLineage(grandchild, child)
    },
    worktreesByRepo: {
      [repo.id]: [parent, child, grandchild]
    }
  }
}
