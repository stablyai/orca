import React from 'react'
import {
  CornerLeftUp,
  Ellipsis,
  FolderInput,
  FolderTree,
  Pin,
  PinOff,
  Plus,
  RefreshCw
} from 'lucide-react'
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
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { getFolderWorkspacePathStatusDescription } from '@/lib/workspace/paths/folder-workspace-path-status'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { FolderWorkspacePathStatus } from '../../../../../../shared/folder-workspaces/folder-workspace-path-status'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getFolderProjectGroupRefreshHandler } from './project-group-folder-refresh'
import {
  buildReparentableProjectGroupMenuEntries,
  resolveProjectGroupParentMenuTargets
} from './project-group-menu-tree'
import { REPO_HEADER_ACTION_BUTTON_CLASS } from './repo-header-action-button-class'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle,
  stopRepoHeaderMenuEvent
} from './header-event-guards'

const EMPTY_PROJECT_GROUPS: readonly ProjectGroup[] = []

export function ProjectGroupHeaderMenu({
  groupId,
  hostId,
  label,
  projectGroup,
  isPinned,
  projectGroups = EMPTY_PROJECT_GROUPS,
  onTogglePinGroup,
  onRefreshProjectGroup,
  onCreateSubgroup,
  onMoveGroup,
  onRename,
  onDelete
}: {
  groupId: string
  /** Owner host of the group row, so mutations route to the host that holds it. */
  hostId?: ExecutionHostId
  label: string
  projectGroup: ProjectGroup | null
  isPinned?: boolean
  projectGroups?: readonly ProjectGroup[]
  onTogglePinGroup?: (groupId: string, nextPinned: boolean, hostId?: ExecutionHostId) => void
  onRefreshProjectGroup?: (projectGroup: ProjectGroup) => void
  onCreateSubgroup?: (groupId: string, groupName: string, hostId?: ExecutionHostId) => void
  onMoveGroup?: (groupId: string, parentGroupId: string | null, hostId?: ExecutionHostId) => void
  onRename: (groupId: string, currentName: string, hostId?: ExecutionHostId) => void
  onDelete: (groupId: string, groupName: string, hostId?: ExecutionHostId) => void
}): React.JSX.Element {
  const t = useTranslate()
  const effectiveIsPinned = isPinned ?? projectGroup?.isPinned === true
  const onRefresh = getFolderProjectGroupRefreshHandler(projectGroup, onRefreshProjectGroup)
  const reparentableEntries = React.useMemo(
    () =>
      onMoveGroup ? buildReparentableProjectGroupMenuEntries(groupId, hostId, projectGroups) : [],
    [groupId, hostId, onMoveGroup, projectGroups]
  )
  const parentTargets = React.useMemo(
    () =>
      onMoveGroup
        ? resolveProjectGroupParentMenuTargets(groupId, hostId, projectGroups)
        : { isNested: false, grandparentGroup: null },
    [groupId, hostId, onMoveGroup, projectGroups]
  )
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={REPO_HEADER_ACTION_BUTTON_CLASS}
          data-repo-header-action=""
          aria-label={t(
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
        {onTogglePinGroup ? (
          <DropdownMenuItem onSelect={() => onTogglePinGroup(groupId, !effectiveIsPinned, hostId)}>
            {effectiveIsPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            {effectiveIsPinned
              ? t('auto.components.sidebar.WorktreeList.unpinGroup', 'Unpin group')
              : t('auto.components.sidebar.WorktreeList.pinGroup', 'Pin group')}
          </DropdownMenuItem>
        ) : null}
        {onRefresh ? (
          <DropdownMenuItem onSelect={onRefresh}>
            <RefreshCw className="size-3.5" />
            {t('auto.components.sidebar.WorktreeList.refreshProjectGroup', 'Refresh projects')}
          </DropdownMenuItem>
        ) : null}
        {onCreateSubgroup ? (
          <DropdownMenuItem onSelect={() => onCreateSubgroup(groupId, label, hostId)}>
            <FolderTree className="size-3.5" />
            {t('auto.components.sidebar.WorktreeList.newSubgroup', 'New subgroup')}
          </DropdownMenuItem>
        ) : null}
        {onMoveGroup && reparentableEntries.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderInput className="size-3.5" />
              {t('auto.components.sidebar.WorktreeList.4a08fb55f2', 'Move to group')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent scrollable>
              {reparentableEntries.map(({ group, depth, disabled, pathLabel }) => (
                <DropdownMenuItem
                  key={group.id}
                  disabled={disabled}
                  aria-label={depth > 0 ? pathLabel : undefined}
                  style={depth > 0 ? { paddingLeft: 8 + Math.min(depth, 6) * 12 } : undefined}
                  onSelect={() => onMoveGroup(groupId, group.id, hostId)}
                >
                  <span className="max-w-48 truncate">{group.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {onMoveGroup && parentTargets.grandparentGroup ? (
          <DropdownMenuItem
            onSelect={() => onMoveGroup(groupId, parentTargets.grandparentGroup!.id, hostId)}
          >
            <CornerLeftUp className="size-3.5" />
            {t(
              'auto.components.sidebar.WorktreeList.moveProjectToParentGroup',
              'Move to parent group ({{group}})',
              { group: parentTargets.grandparentGroup.name }
            )}
          </DropdownMenuItem>
        ) : null}
        {onMoveGroup && parentTargets.isNested ? (
          <DropdownMenuItem onSelect={() => onMoveGroup(groupId, null, hostId)}>
            <CornerLeftUp className="size-3.5" />
            {t('auto.components.sidebar.WorktreeList.moveGroupToTopLevel', 'Move to top level')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => onRename(groupId, label, hostId)}>
          {t('auto.components.sidebar.WorktreeList.4d7b73658c', 'Rename group')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(groupId, label, hostId)}>
          {t('auto.components.sidebar.WorktreeList.902115cdbe', 'Delete group')}
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
  const t = useTranslate()
  const createLabel = t(
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
          ? getFolderWorkspacePathStatusDescription(pathStatus, t)
          : createLabel}
      </TooltipContent>
    </Tooltip>
  )
}
