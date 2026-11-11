import type React from 'react'
import type { FolderWorkspacePathStatus } from '../../../../../../shared/folder-workspaces/folder-workspace-path-status'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition
} from '../../../../../../shared/worktree/types'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { WorktreeSidebarHeaderDrag } from '../drag/use-header-drag'
import type { ProjectHeaderHostContext } from './project-header-host-context'
import type { RepoHeaderProjectActions } from './repo-header-project-actions'

export type SectionHeaderRowContext = {
  groupBy: WorktreeGroupBy
  projectHeaderHostContexts?: ReadonlyMap<string, ProjectHeaderHostContext>
  collapsedGroups: Set<string>
  workspaceStatusById?: ReadonlyMap<string, WorkspaceStatusDefinition>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectGroups: readonly ProjectGroup[]
  highlightedRevealRowKey: string | null
  dragOverStatus: WorkspaceStatus | null
  pinDragOver: boolean
  headerDrag: WorktreeSidebarHeaderDrag
  getCachedFolderWorkspacePathStatus: (request: {
    scope: 'project-group'
    projectGroupId: string
  }) => FolderWorkspacePathStatus | null
  toggleGroupWithScrollAnchor: (groupKey: string) => void
  toggleAllProjects?: () => void
  projectActions: RepoHeaderProjectActions
  onRenameProjectGroup: (groupId: string, currentName: string, hostId?: ExecutionHostId) => void
  onDeleteProjectGroup: (groupId: string, groupName: string, hostId?: ExecutionHostId) => void
  onRefreshProjectGroup?: (projectGroup: ProjectGroup) => void
  onCreateFolderWorkspace: (projectGroup: ProjectGroup) => void
  onWorkspaceStatusDragOver: (event: React.DragEvent, status: WorkspaceStatus) => void
  onWorkspaceStatusDragLeave: (event: React.DragEvent) => void
  onWorkspacePinDragOver: (event: React.DragEvent) => void
  onWorkspacePinDragLeave: (event: React.DragEvent) => void
  onWorkspaceStatusDrop: (event: React.DragEvent, status: WorkspaceStatus) => void
}
