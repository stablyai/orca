import type { Repo } from '../../repository/repo-types'
import type { ProjectOrderBy } from '../../ui-chrome/ui-chrome-types'
import type { WorkspaceSortBy } from '../../workspace-view/workspace-row-sort'
import type { WorkspaceStatusDefinition, Worktree } from '../../worktree/types'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  SidebarPRGroupReader,
  WorktreeGroupBy
} from '../row-types'
import type { RenderableFolderWorkspace } from '../folders/folder-workspace-lanes'
import {
  getFolderLaneSections,
  type getSidebarFolderOccurrences
} from '../folders/folder-workspace-occurrences'
import type { WorktreeOccurrenceSection } from '../lineage/worktree-occurrence-plan'
import { ALL_GROUP_KEY, PINNED_GROUP_KEY } from './group-keys'
import type { getProjectGroupOccurrencePaths } from './project-group-sections'
import type { ProjectGroupingIndex } from './project-section-grouping'
import { orderMainWorktreeFirst } from './section-order'
import type { OrderedGroupEntry, WorktreeGroupEntry } from './worktree-group-entry'
import { buildOrderedGroups } from './worktree-grouping'

export type SidebarOccurrenceSection = WorktreeOccurrenceSection<Worktree> & {
  group: WorktreeGroupEntry
}

export function buildSidebarOccurrenceSections(args: {
  groupBy: WorktreeGroupBy
  sortBy: WorkspaceSortBy
  pinned: readonly Worktree[]
  natural: readonly Worktree[]
  displayRootByIdentity: ReadonlyMap<string, Worktree>
  folders: ReturnType<typeof getSidebarFolderOccurrences>
  lineageChildren: ReadonlyMap<string, readonly Worktree[]>
  repoMap: Map<string, Repo>
  prGroupOf: SidebarPRGroupReader
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectIndex: ProjectGroupingIndex | null
  placeholderRepoIds: ReadonlySet<string>
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  newExternalWorktreesInboxByRepo: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
  pendingByRepo: ReadonlyMap<string, PendingCreationRef[]>
  repoOrder?: Map<string, number>
  projectOrderBy: ProjectOrderBy
  renderableFolderWorkspaces: readonly RenderableFolderWorkspace[]
  projectGroupPaths: ReturnType<typeof getProjectGroupOccurrencePaths>
}): SidebarOccurrenceSection[] {
  const {
    groupBy,
    sortBy,
    pinned,
    natural,
    displayRootByIdentity,
    folders,
    lineageChildren,
    repoMap,
    prGroupOf,
    workspaceStatuses,
    projectIndex,
    placeholderRepoIds,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    pendingByRepo,
    repoOrder,
    projectOrderBy,
    renderableFolderWorkspaces,
    projectGroupPaths
  } = args
  const folderBound =
    groupBy === 'repo'
      ? folders.boundRowsByGroupId(natural, displayRootByIdentity, lineageChildren)
      : null
  // Rows under a folder still count in their own projects; only their display moves.
  const naturalWorktrees = folders.projectRows(natural, groupBy === 'repo')
  const groups: OrderedGroupEntry[] =
    groupBy === 'none'
      ? [[ALL_GROUP_KEY, { label: '', items: naturalWorktrees, repoIds: new Set() }]]
      : buildOrderedGroups({
          groupBy,
          naturalWorktrees,
          repoMap,
          prGroupOf,
          workspaceStatuses,
          projectIndex,
          displayRootByIdentity: folderBound?.groupingRootByIdentity ?? displayRootByIdentity,
          placeholderRepoIds,
          importedWorktreesByRepo,
          newExternalWorktreesInboxByRepo,
          pendingByRepo,
          repoOrder,
          projectOrderBy,
          folderWorkspaces: renderableFolderWorkspaces
        })
  if (pinned.length > 0) {
    groups.unshift([PINNED_GROUP_KEY, { label: '', items: [...pinned], repoIds: new Set() }])
  }
  const boundSet = folderBound && folderBound.bound.size > 0 ? folderBound.bound : null
  const sections: SidebarOccurrenceSection[] = []
  for (let i = 0; i < groups.length; i += 1) {
    const [key, group] = groups[i]
    const revealPath =
      groupBy === 'repo' && key !== PINNED_GROUP_KEY && group.repo?.projectGroupId
        ? projectGroupPaths.get(group.repo.projectGroupId)
        : undefined
    const orderedItems =
      groupBy === 'repo' && key !== PINNED_GROUP_KEY
        ? orderMainWorktreeFirst(group.items, sortBy)
        : group.items
    const items =
      boundSet && key !== PINNED_GROUP_KEY
        ? orderedItems.filter((row) => !boundSet.has(row))
        : orderedItems
    const folderRows = key === ALL_GROUP_KEY ? folders.rows : folders.rowsOf(group.folderWorkspaces)
    sections.push({
      key,
      group,
      placement: key === PINNED_GROUP_KEY ? 'pinned' : 'natural',
      // Folder rows follow the lane's worktrees, as their rows always have.
      items: folderRows.length > 0 ? [...items, ...folderRows] : items,
      revealPath: { key, parent: revealPath }
    })
  }
  const folderLaneSections = getFolderLaneSections(folderBound, projectGroupPaths)
  return folderLaneSections.length > 0 ? [...sections, ...folderLaneSections] : sections
}
