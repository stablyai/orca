import React from 'react'
import { Check, Ellipsis, Plus } from 'lucide-react'
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
import { useAppStore } from '@/store'
import { REPO_COLORS } from '../../../../../../shared/constants'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getFolderWorkspacePathStatusDescription } from '@/lib/folder-workspace-path-status'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { FolderWorkspacePathStatus } from '../../../../../../shared/folder-workspace-path-status'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { REPO_HEADER_ACTION_BUTTON_CLASS } from '../../repo-header-action-button-class'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle,
  stopRepoHeaderMenuEvent
} from './header-event-guards'

// Same order as REPO_COLORS.
const GROUP_COLOR_NAMES = ['Gray', 'Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Purple', 'Pink']

export function ProjectGroupHeaderMenu({
  groupId,
  hostId,
  label,
  color,
  onRename,
  onDelete
}: {
  groupId: string
  /** Owner host of the group row, so rename/delete route to the host that holds it. */
  hostId?: ExecutionHostId
  label: string
  color: string | null
  onRename: (groupId: string, currentName: string, hostId?: ExecutionHostId) => void
  onDelete: (groupId: string, groupName: string, hostId?: ExecutionHostId) => void
}): React.JSX.Element {
  const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)
  const setColor = (next: string | null): void => {
    void updateProjectGroup(groupId, { color: next }, { hostId })
  }
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
        <DropdownMenuItem onSelect={() => onRename(groupId, label, hostId)}>
          {translate('auto.components.sidebar.WorktreeList.4d7b73658c', 'Rename group')}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {translate('auto.components.sidebar.WorktreeList.groupColor', 'Group color')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={() => setColor(null)}>
              <span className="size-3 rounded-full border border-border" />
              {translate('auto.components.sidebar.WorktreeList.groupColorNone', 'None')}
              {color === null ? <Check className="ml-auto size-3.5" /> : null}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {REPO_COLORS.map((swatch, index) => (
              <DropdownMenuItem key={swatch} onSelect={() => setColor(swatch)}>
                <span className="size-3 rounded-full" style={{ backgroundColor: swatch }} />
                {GROUP_COLOR_NAMES[index] ?? swatch}
                {color === swatch ? <Check className="ml-auto size-3.5" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
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
