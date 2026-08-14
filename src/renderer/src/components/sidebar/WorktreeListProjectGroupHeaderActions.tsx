import { Ellipsis, Plus } from 'lucide-react'
import type { FolderWorkspacePathStatus } from '../../../../shared/folder-workspace-path-status'
import type { ProjectGroup } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { getFolderWorkspacePathStatusDescription } from '@/lib/folder-workspace-path-status'
import type { GroupHeaderRow } from './worktree-list-groups'
import { REPO_HEADER_ACTION_BUTTON_CLASS } from './repo-header-action-button-class'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle,
  stopRepoHeaderMenuEvent
} from './worktree-list-project-header-events'

export function WorktreeListProjectGroupHeaderActions({
  row,
  projectGroupPathStatus,
  folderWorkspaceCreateDisabled,
  onRenameProjectGroup,
  onDeleteProjectGroup,
  onCreateFolderWorkspace
}: {
  row: GroupHeaderRow
  projectGroupPathStatus: FolderWorkspacePathStatus | null
  folderWorkspaceCreateDisabled: boolean
  onRenameProjectGroup: (groupId: string, currentName: string) => void
  onDeleteProjectGroup: (groupId: string, groupName: string) => void
  onCreateFolderWorkspace: (projectGroup: ProjectGroup) => void
}) {
  if (row.repo || !row.projectGroup || typeof row.projectGroup.id !== 'string') {
    return null
  }

  return (
    <>
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
              { value0: row.label }
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
            onSelect={() => {
              if (row.projectGroup?.id) {
                onRenameProjectGroup(row.projectGroup.id, row.label)
              }
            }}
          >
            {translate('auto.components.sidebar.WorktreeList.4d7b73658c', 'Rename group')}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => {
              if (row.projectGroup?.id) {
                onDeleteProjectGroup(row.projectGroup.id, row.label)
              }
            }}
          >
            {translate('auto.components.sidebar.WorktreeList.902115cdbe', 'Delete group')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {'parentPath' in row.projectGroup && row.projectGroup.parentPath ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-repo-header-action=""
              className={cn(
                REPO_HEADER_ACTION_BUTTON_CLASS,
                folderWorkspaceCreateDisabled &&
                  'cursor-not-allowed text-muted-foreground/60 hover:bg-transparent hover:text-muted-foreground/60'
              )}
              aria-label={translate(
                'auto.components.sidebar.WorktreeList.bd37a57ac8',
                'Create workspace for {{value0}}',
                { value0: row.label }
              )}
              aria-disabled={folderWorkspaceCreateDisabled}
              onKeyDown={stopRepoHeaderKeyboardToggle}
              onPointerDown={handleRepoHeaderActionPointerDown}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                if (folderWorkspaceCreateDisabled) {
                  return
                }
                if (
                  row.projectGroup &&
                  'parentPath' in row.projectGroup &&
                  row.projectGroup.parentPath
                ) {
                  onCreateFolderWorkspace(row.projectGroup)
                }
              }}
            >
              <Plus className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {projectGroupPathStatus?.exists === false
              ? getFolderWorkspacePathStatusDescription(projectGroupPathStatus)
              : translate(
                  'auto.components.sidebar.WorktreeList.bd37a57ac8',
                  'Create workspace for {{value0}}',
                  { value0: row.label }
                )}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  )
}
