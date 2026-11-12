import React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/class-names'
import type { FolderWorkspacePathStatus } from '../../../../../../shared/folder-workspaces/folder-workspace-path-status'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import {
  isSingleHostProjectHeader,
  type GroupHeaderRow
} from '../../../../../../shared/sidebar-list/row-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { isFolderWorkspaceCreateDisabled } from './FolderPathStatusIndicator'
import {
  ProjectGroupCreateWorkspaceButton,
  ProjectGroupHeaderMenu
} from './project-group-header-actions'
import {
  RepoHeaderCreateWorkspaceButton,
  RepoHeaderProjectActionsMenu,
  type RepoHeaderProjectActions
} from './repo-header-project-actions'
import { handleRepoHeaderCollapseAffordancePointerDown } from './header-event-guards'

// Hover actions overlay titles; touch keeps them in flow. Pointer/self-stretch prevent action gutters becoming drag handles.
export const PROJECT_HEADER_ACTIONS_CLASS_NAME = cn(
  'flex shrink-0 cursor-pointer items-center gap-0.5 self-stretch',
  'can-hover:absolute can-hover:right-1 can-hover:top-1/2 can-hover:z-10 can-hover:-translate-y-1/2',
  'can-hover:rounded-md can-hover:bg-worktree-sidebar can-hover:pl-1',
  'can-hover:pointer-events-none can-hover:opacity-0 can-hover:transition-opacity',
  'group-hover:pointer-events-auto group-hover:opacity-100',
  'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
  'has-[button[aria-expanded=true]]:pointer-events-auto has-[button[aria-expanded=true]]:opacity-100'
)

export function ProjectHeaderActions({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      data-repo-header-actions=""
      className={cn(PROJECT_HEADER_ACTIONS_CLASS_NAME, className)}
      {...props}
    />
  )
}

export function SectionHeaderTrailingActions({
  row,
  label,
  isRepoView,
  showHeaderCollapseAffordance,
  isHeaderCollapsed,
  onToggleHeader,
  projectGroupIdForHeader,
  projectGroupHostIdForHeader,
  folderBackedProjectGroup,
  projectGroupPathStatus,
  projectGroups,
  projectActions,
  onRefreshProjectGroup,
  onCreateProjectSubgroup,
  onMoveProjectGroup,
  onRenameProjectGroup,
  onDeleteProjectGroup,
  onCreateFolderWorkspace
}: {
  row: GroupHeaderRow
  label: string
  isRepoView: boolean
  showHeaderCollapseAffordance: boolean
  isHeaderCollapsed: boolean
  onToggleHeader: (event: React.MouseEvent) => void
  projectGroupIdForHeader?: string
  projectGroupHostIdForHeader?: ExecutionHostId
  folderBackedProjectGroup: ProjectGroup | null
  projectGroupPathStatus: FolderWorkspacePathStatus | null
  projectGroups: readonly ProjectGroup[]
  projectActions: RepoHeaderProjectActions
  onRefreshProjectGroup?: (projectGroup: ProjectGroup) => void
  onCreateProjectSubgroup?: (groupId: string, groupName: string, hostId?: ExecutionHostId) => void
  onMoveProjectGroup?: (
    groupId: string,
    parentGroupId: string | null,
    hostId?: ExecutionHostId
  ) => void
  onRenameProjectGroup: (groupId: string, currentName: string, hostId?: ExecutionHostId) => void
  onDeleteProjectGroup: (groupId: string, groupName: string, hostId?: ExecutionHostId) => void
  onCreateFolderWorkspace: (projectGroup: ProjectGroup) => void
}): React.JSX.Element {
  return (
    <ProjectHeaderActions>
      {showHeaderCollapseAffordance ? (
        <div
          className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
          data-repo-header-collapse-affordance=""
          aria-hidden
          onPointerDown={handleRepoHeaderCollapseAffordancePointerDown}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onToggleHeader(event)
          }}
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform', isHeaderCollapsed && '-rotate-90')}
          />
        </div>
      ) : null}

      {isRepoView && !row.repo && projectGroupIdForHeader ? (
        <ProjectGroupHeaderMenu
          groupId={projectGroupIdForHeader}
          hostId={projectGroupHostIdForHeader}
          label={label}
          projectGroup={folderBackedProjectGroup}
          projectGroups={projectGroups}
          onRefreshProjectGroup={onRefreshProjectGroup}
          onCreateSubgroup={onCreateProjectSubgroup}
          onMoveGroup={onMoveProjectGroup}
          onRename={onRenameProjectGroup}
          onDelete={onDeleteProjectGroup}
        />
      ) : null}

      {folderBackedProjectGroup ? (
        <ProjectGroupCreateWorkspaceButton
          projectGroup={folderBackedProjectGroup}
          label={label}
          pathStatus={projectGroupPathStatus}
          disabled={isFolderWorkspaceCreateDisabled(projectGroupPathStatus)}
          onCreate={onCreateFolderWorkspace}
        />
      ) : null}

      {row.repo && isRepoView ? (
        <RepoHeaderProjectActionsMenu
          repo={row.repo}
          label={label}
          projectGroups={row.hostRepos ? [] : projectGroups}
          actions={projectActions}
        />
      ) : null}

      {row.repo && isRepoView ? (
        <RepoHeaderCreateWorkspaceButton
          key={`${row.repo.executionHostId ?? 'local'}:${row.repo.connectionId ?? ''}`}
          repo={row.repo}
          label={label}
          pinHost={isSingleHostProjectHeader(row)}
          onCreateForRepo={projectActions.onCreateForRepo}
        />
      ) : null}
    </ProjectHeaderActions>
  )
}
