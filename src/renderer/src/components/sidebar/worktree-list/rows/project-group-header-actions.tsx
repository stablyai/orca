import React from 'react'
import { Ellipsis, Plus } from 'lucide-react'
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
import { REPO_HEADER_ACTION_BUTTON_CLASS } from '../../repo-header-action-button-class'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle,
  stopRepoHeaderMenuEvent
} from './header-event-guards'
import { PROJECT_GROUP_HEADER_INDENT } from './indentation'
import { canCreateProjectSubgroup, getProjectGroupMoveTargets } from './project-group-move-targets'

// Why: matches the item's `px-2` so depth 0 sits flush with the other entries.
const MENU_ITEM_PADDING_LEFT = 8

function ProjectGroupMoveSubmenu({
  groupId,
  projectGroups,
  onMoveToGroup
}: {
  groupId: string
  projectGroups: readonly ProjectGroup[]
  onMoveToGroup: (groupId: string, parentGroupId: string | null) => void
}): React.JSX.Element | null {
  const targets = getProjectGroupMoveTargets(projectGroups, groupId)
  const isTopLevel = !projectGroups.find((group) => group.id === groupId)?.parentGroupId
  if (targets.length === 0 && isTopLevel) {
    return null
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {translate('auto.components.sidebar.WorktreeList.4a08fb55f2', 'Move to group')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem disabled={isTopLevel} onSelect={() => onMoveToGroup(groupId, null)}>
          {translate('auto.components.sidebar.WorktreeList.moveGroupTopLevel', 'Top level')}
        </DropdownMenuItem>
        {targets.length > 0 ? <DropdownMenuSeparator /> : null}
        {targets.map(({ group, depth, isCurrentParent }) => (
          <DropdownMenuItem
            key={group.id}
            disabled={isCurrentParent}
            data-project-group-move-target={group.id}
            // Why: nested names repeat across subtrees; mirror the sidebar indent so the path is readable.
            style={{ paddingLeft: MENU_ITEM_PADDING_LEFT + depth * PROJECT_GROUP_HEADER_INDENT }}
            onSelect={() => onMoveToGroup(groupId, group.id)}
          >
            <span className="max-w-48 truncate">{group.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export function ProjectGroupHeaderMenu({
  groupId,
  label,
  projectGroups,
  onRename,
  onDelete,
  onCreateSubgroup,
  onMoveToGroup
}: {
  groupId: string
  label: string
  projectGroups: readonly ProjectGroup[]
  onRename: (groupId: string, currentName: string) => void
  onDelete: (groupId: string, groupName: string) => void
  onCreateSubgroup: (parentGroupId: string, parentName: string) => void
  onMoveToGroup: (groupId: string, parentGroupId: string | null) => void
}): React.JSX.Element {
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
        <DropdownMenuItem
          disabled={!canCreateProjectSubgroup(projectGroups, groupId)}
          onSelect={() => onCreateSubgroup(groupId, label)}
        >
          {translate('auto.components.sidebar.WorktreeList.newSubgroup', 'New subgroup…')}
        </DropdownMenuItem>
        <ProjectGroupMoveSubmenu
          groupId={groupId}
          projectGroups={projectGroups}
          onMoveToGroup={onMoveToGroup}
        />
        <DropdownMenuItem onSelect={() => onRename(groupId, label)}>
          {translate('auto.components.sidebar.WorktreeList.4d7b73658c', 'Rename group')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(groupId, label)}>
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
