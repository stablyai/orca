import React from 'react'
import { Ellipsis, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getFolderWorkspacePathStatusDescription } from '@/lib/folder-workspace-path-status'
import { getProjectGroupHostId } from '@/store/slices/project-group-owner-routing'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { FolderWorkspacePathStatus } from '../../../../../../shared/folder-workspace-path-status'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { canCreateProjectSubgroup } from '../../../../../../shared/project-group-nesting'
import { REPO_HEADER_ACTION_BUTTON_CLASS } from '../../repo-header-action-button-class'
import { ProjectGroupMoveSubmenu } from '../../ProjectGroupMoveSubmenu'
import { selectProjectGroupCatalog } from '../../project-group-move-targets'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle,
  stopRepoHeaderMenuEvent
} from './header-event-guards'

// hostId is the group row's owner host, so each action routes to the host that holds the group.
export type ProjectGroupHeaderActions = {
  onRename: (groupId: string, currentName: string, hostId?: ExecutionHostId) => void
  onCreateSubgroup: (parentGroupId: string, parentName: string, hostId?: ExecutionHostId) => void
  onMove: (groupId: string, parentGroupId: string | null, hostId?: ExecutionHostId) => void
  onDelete: (groupId: string, groupName: string, hostId?: ExecutionHostId) => void
}

type ProjectGroupHeaderMenuProps = {
  projectGroup: ProjectGroup
  label: string
  /** Every host's groups; the menu narrows them to this group's host. */
  projectGroups: readonly ProjectGroup[]
  actions: ProjectGroupHeaderActions
}

export function ProjectGroupHeaderMenu(props: ProjectGroupHeaderMenuProps): React.JSX.Element {
  const { label } = props
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={REPO_HEADER_ACTION_BUTTON_CLASS}
          data-repo-header-action=""
          aria-label={translate(
            'auto.components.sidebar.WorktreeList.79465e9034',
            'Group actions for {{value0}}',
            { value0: label }
          )}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={stopRepoHeaderKeyboardToggle}
          onPointerDown={handleRepoHeaderActionPointerDown}
        >
          <Ellipsis className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={6}
        // Why: Radix portals keep React bubbling through the project header; block menu events from arming row drag/collapse.
        onPointerDown={stopRepoHeaderMenuEvent}
        onMouseDown={stopRepoHeaderMenuEvent}
        onPointerUp={stopRepoHeaderMenuEvent}
        onMouseUp={stopRepoHeaderMenuEvent}
        onClick={stopRepoHeaderMenuEvent}
        onKeyDown={stopRepoHeaderMenuEvent}
      >
        <ProjectGroupHeaderMenuItems {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Why: mounted only while the menu is open, so the catalog walk never runs per sidebar row.
function ProjectGroupHeaderMenuItems({
  projectGroup,
  label,
  projectGroups,
  actions
}: ProjectGroupHeaderMenuProps): React.JSX.Element {
  const groupId = projectGroup.id
  const hostId = getProjectGroupHostId(projectGroup)
  // Why: the level comes from the host's whole catalog; row depth reads 0 when a filter hides a parent.
  const canCreateSubgroup = canCreateProjectSubgroup(
    selectProjectGroupCatalog(projectGroups, hostId),
    groupId
  )
  return (
    <>
      <DropdownMenuItem onSelect={() => actions.onRename(groupId, label, hostId)}>
        {translate('auto.components.sidebar.WorktreeList.4d7b73658c', 'Rename group')}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!canCreateSubgroup}
        onSelect={() => actions.onCreateSubgroup(groupId, label, hostId)}
      >
        {translate(
          'auto.components.sidebar.worktree.list.rows.project.group.header.actions.dd93986e77',
          'New subgroup'
        )}
      </DropdownMenuItem>
      <ProjectGroupMoveSubmenu
        projectGroups={projectGroups}
        movingGroup={projectGroup}
        onSelect={(parentGroupId) => actions.onMove(groupId, parentGroupId, hostId)}
      >
        {translate('auto.components.sidebar.WorktreeList.4a08fb55f2', 'Move to group')}
      </ProjectGroupMoveSubmenu>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        onSelect={() => actions.onDelete(groupId, label, hostId)}
      >
        {translate('auto.components.sidebar.WorktreeList.902115cdbe', 'Delete group')}
      </DropdownMenuItem>
    </>
  )
}

export function ProjectGroupCreateWorkspaceButton({
  projectGroup,
  label,
  pathStatus,
  disabled,
  onCreate
}: {
  projectGroup: ProjectGroup
  label: string
  pathStatus: FolderWorkspacePathStatus | null
  disabled: boolean
  onCreate: (projectGroup: ProjectGroup) => void
}): React.JSX.Element {
  const createLabel = translate(
    'auto.components.sidebar.WorktreeList.bd37a57ac8',
    'Create workspace for {{value0}}',
    { value0: label }
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-repo-header-action=""
          className={cn(
            REPO_HEADER_ACTION_BUTTON_CLASS,
            disabled &&
              'cursor-not-allowed text-muted-foreground/60 hover:bg-transparent hover:text-muted-foreground/60'
          )}
          aria-label={createLabel}
          aria-disabled={disabled}
          onKeyDown={stopRepoHeaderKeyboardToggle}
          onPointerDown={handleRepoHeaderActionPointerDown}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            if (disabled) {
              return
            }
            onCreate(projectGroup)
          }}
        >
          <Plus className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {pathStatus?.exists === false
          ? getFolderWorkspacePathStatusDescription(pathStatus)
          : createLabel}
      </TooltipContent>
    </Tooltip>
  )
}
