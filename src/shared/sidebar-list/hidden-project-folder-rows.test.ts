import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../folder-workspaces/folder-workspace-types'
import { getFolderWorkspaceWorktree } from '../folder-workspaces/folder-workspace-worktree'
import { hiddenProjectRowFacts, indexHiddenProjects } from '../project/catalog/hidden-projects'
import type { ProjectGroup } from '../project/groups/project-group-types'
import type { Repo } from '../repository/repo-types'
import { cloneDefaultWorkspaceStatuses } from '../workspace/status/workspace-statuses'
import { NO_WORKSPACE_ROW_FILTERS } from '../workspace-view/workspace-row-filters'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import type { Worktree } from '../worktree/types'
import { selectVisibleSidebarWorktrees } from './selection/visible-worktrees'
import { planSidebarRows } from './sidebar-row-plan'

const group: ProjectGroup = {
  id: 'group-1',
  name: 'services',
  parentPath: '/src',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}
const repo = (id: string, hiddenAt?: number): Repo => ({
  id,
  path: `/src/${id}`,
  displayName: id,
  badgeColor: '#000000',
  addedAt: 0,
  projectGroupId: group.id,
  ...(hiddenAt === undefined ? {} : { hiddenAt })
})
const backend = repo('backend')
const specs = repo('backend-specs', 1)
const folder: FolderWorkspace = {
  id: 'task-1',
  projectGroupId: group.id,
  name: 'TASK-1',
  folderPath: '/src',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 0,
  updatedAt: 0
}
const worktree = (id: string, repoId: string, isMainWorktree = false): Worktree => ({
  id,
  repoId,
  path: `/wt/${id}`,
  branch: `refs/heads/${id}`,
  head: 'abc',
  isBare: false,
  isMainWorktree,
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  isPinned: false,
  displayName: id,
  sortOrder: 0,
  lastActivityAt: 0
})

describe('hidden project rows under a folder workspace (#43083)', () => {
  it('lists them under the folder without bringing back the hidden project', () => {
    const repos = [backend, specs]
    const backendTask = worktree('backend-task', backend.id)
    const specsTask = worktree('specs-task', specs.id)
    const specsMain = worktree('specs-main', specs.id, true)
    const backendSub = worktree('backend-sub', backend.id)
    const rows = [backendTask, specsTask, specsMain, backendSub]
    const folderIdentity = getWorktreeHostIdentity(getFolderWorkspaceWorktree(folder))
    const lineageParentIdentities = new Map([
      [getWorktreeHostIdentity(backendTask), folderIdentity],
      [getWorktreeHostIdentity(specsTask), folderIdentity],
      [getWorktreeHostIdentity(backendSub), getWorktreeHostIdentity(specsTask)]
    ])
    const hiddenProjects = indexHiddenProjects(repos, 'local')
    const visible = selectVisibleSidebarWorktrees({
      rows,
      ancestorByIdentity: new Map(rows.map((row) => [getWorktreeHostIdentity(row), row])),
      rankOf: () => undefined,
      filters: NO_WORKSPACE_ROW_FILTERS,
      facts: {
        isArchived: () => false,
        ...hiddenProjectRowFacts(hiddenProjects),
        isFolderWorkspace: () => false,
        repoId: (row) => row.repoId,
        hostId: () => 'local',
        isOtherClient: () => false,
        isDefaultBranch: () => false,
        isAutomationCreated: () => false,
        isCliCreated: () => false,
        isDetachedHead: () => false,
        isMainWorktree: (row) => row.isMainWorktree,
        isSleeping: () => false
      },
      worktreeLineageById: {},
      lineageParentIdentities,
      filterRepoIds: []
    })
    const rendered = planSidebarRows({
      groupBy: 'repo',
      sortBy: 'smart',
      worktrees: visible,
      repoMap: new Map(repos.map((entry) => [entry.id, entry])),
      prGroupOf: () => 'in-progress',
      workspaceStatuses: cloneDefaultWorkspaceStatuses(),
      projectOrderBy: 'manual',
      lineageById: {},
      lineageParentIdentities,
      worktreeMap: new Map(rows.map((row) => [row.id, row])),
      nestLineage: true,
      projectGroups: [group],
      placeholderRepoIds: new Set(),
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      pendingCreations: [],
      folderWorkspaces: [folder],
      defaultHostId: 'local',
      pinnedDisplayPolicy: 'single-location',
      filterRepoIds: [],
      hiddenProjects
    }).render(new Set())

    expect(
      rendered.flatMap((row) => {
        switch (row.type) {
          case 'header':
            return [`header ${row.repo?.id ?? row.key}`]
          case 'folder-workspace':
            return [`folder ${row.folderWorkspace.name}`]
          case 'item':
            return [`${'  '.repeat(row.depth)}item ${row.worktree.id}`]
          case 'imported-worktrees-card':
          case 'new-external-worktrees-inbox':
          case 'pending-creation':
            return []
        }
      })
    ).toEqual([
      'header project-group:group-1',
      'folder TASK-1',
      '  item backend-task',
      '  item specs-task',
      '    item backend-sub',
      'header backend'
    ])
  })
})
