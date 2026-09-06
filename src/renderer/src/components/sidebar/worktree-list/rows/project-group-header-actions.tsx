import React, { useMemo } from 'react'
import { Ellipsis, FolderInput, FolderPlus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getFolderWorkspacePathStatusDescription } from '@/lib/folder-workspace-path-status'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { FolderWorkspacePathStatus } from '../../../../../../shared/folder-workspace-path-status'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { listProjectGroupReparentTargets } from '../../../../../../shared/project-groups'
import { getProjectGroupHostId } from '@/store/slices/project-group-owner-routing'
import { REPO_HEADER_ACTION_BUTTON_CLASS } from '../../repo-header-action-button-class'
import {
  flattenProjectGroupsForMenu,
  formatProjectGroupMenuLabel
} from '../../project-group-menu-labels'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle,
  stopRepoHeaderMenuEvent
} from './header-event-guards'

export function ProjectGroupHeaderMenu({
  groupId,
  hostId,
  label,
  projectGroups,
  onRename,
  onDelete,
  onFocus,
  onClearFocus,
  onCreateNestedClient,
  onMoveInto,
  isFocused
}: {
  groupId: string
  /** Owner host of the group row, so rename/delete route to the host that holds it. */
  hostId?: ExecutionHostId
  label: string
  projectGroups: readonly ProjectGroup[]
  onRename: (groupId: string, currentName: string, hostId?: ExecutionHostId) => void
  onDelete: (groupId: string, groupName: string, hostId?: ExecutionHostId) => void
  onFocus?: (groupId: string) => void
  onClearFocus?: () => void
  onCreateNestedClient?: (parentGroupId: string, hostId?: ExecutionHostId) => void
  onMoveInto?: (groupId: string, parentGroupId: string | null, hostId?: ExecutionHostId) => void
  isFocused?: boolean
}): React.JSX.Element {
  const groupsById = useMemo(
    () => new Map(projectGroups.map((group) => [group.id, group])),
    [projectGroups]
  )
  const currentGroup = groupsById.get(groupId)
  const currentHostId = currentGroup ? getProjectGroupHostId(currentGroup) : null
  const reparentTargets = useMemo(() => {
    const sameHostGroups = currentHostId
      ? projectGroups.filter((group) => getProjectGroupHostId(group) === currentHostId)
      : projectGroups
    return flattenProjectGroupsForMenu(listProjectGroupReparentTargets(sameHostGroups, groupId))
  }, [currentHostId, groupId, projectGroups])
  const canMoveToTopLevel = Boolean(currentGroup?.parentGroupId)

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
        {isFocused ? (
          <DropdownMenuItem onSelect={() => onClearFocus?.()}>
            {translate('auto.components.sidebar.WorktreeList.showAllClients', 'Show all clients')}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => onFocus?.(groupId)}>
            {translate('auto.components.sidebar.WorktreeList.focusClient', 'Show only this client')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => onCreateNestedClient?.(groupId, hostId)}>
          <FolderPlus className="size-3.5" strokeWidth={2.25} />
          {translate('auto.components.sidebar.WorktreeList.newClientInside', 'New client inside…')}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FolderInput className="size-3.5" strokeWidth={2.25} />
            {translate(
              'auto.components.sidebar.WorktreeList.moveClientInto',
              'Move into another client'
            )}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {canMoveToTopLevel ? (
              <DropdownMenuItem onSelect={() => onMoveInto?.(groupId, null, hostId)}>
                {translate(
                  'auto.components.sidebar.WorktreeList.moveClientToTopLevel',
                  'Top level'
                )}
              </DropdownMenuItem>
            ) : null}
            {canMoveToTopLevel && reparentTargets.length > 0 ? <DropdownMenuSeparator /> : null}
            {reparentTargets.length > 0 ? (
              reparentTargets.map((group) => (
                <DropdownMenuItem
                  key={group.id}
                  disabled={currentGroup?.parentGroupId === group.id}
                  onSelect={() => onMoveInto?.(groupId, group.id, hostId)}
                >
                  <span className="max-w-48 truncate">
                    {formatProjectGroupMenuLabel(group, groupsById)}
                  </span>
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuItem disabled>
                {translate(
                  'auto.components.sidebar.WorktreeList.moveClientIntoEmpty',
                  'Create another client first'
                )}
              </DropdownMenuItem>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={() => onRename(groupId, label, hostId)}>
          {translate('auto.components.sidebar.WorktreeList.4d7b73658c', 'Rename group')}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(groupId, label, hostId)}>
          {translate('auto.components.sidebar.WorktreeList.902115cdbe', 'Delete group')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
