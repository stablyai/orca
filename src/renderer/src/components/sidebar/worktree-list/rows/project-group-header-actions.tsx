import React, { useState } from 'react'
import { Ellipsis, Plus } from 'lucide-react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { getFolderWorkspacePathStatusDescription } from '@/lib/workspace/paths/folder-workspace-path-status'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { FolderWorkspacePathStatus } from '../../../../../../shared/folder-workspaces/folder-workspace-path-status'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { REPO_HEADER_ACTION_BUTTON_CLASS } from './repo-header-action-button-class'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from './header-event-guards'

const LazyProjectGroupHeaderMenuContent = lazyWithRetry(
  () =>
    import('./ProjectGroupHeaderMenuContent').then((module) => ({
      default: module.ProjectGroupHeaderMenuContent
    })),
  { reloadKey: 'project-group-header-menu-content' }
)

export function ProjectGroupHeaderMenu({
  groupId,
  hostId,
  label,
  projectGroup,
  onRefreshProjectGroup,
  onRename,
  onDelete
}: {
  groupId: string
  /** Owner host of the group row, so rename/delete route to the host that holds it. */
  hostId?: ExecutionHostId
  label: string
  projectGroup: ProjectGroup | null
  onRefreshProjectGroup?: (projectGroup: ProjectGroup) => void
  onRename: (groupId: string, currentName: string, hostId?: ExecutionHostId) => void
  onDelete: (groupId: string, groupName: string, hostId?: ExecutionHostId) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const hasOpened = useLatchedOpen(open)
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
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
      {hasOpened ? (
        <React.Suspense fallback={null}>
          <LazyProjectGroupHeaderMenuContent
            groupId={groupId}
            hostId={hostId}
            label={label}
            projectGroup={projectGroup}
            onRefreshProjectGroup={onRefreshProjectGroup}
            onRename={onRename}
            onDelete={onDelete}
          />
        </React.Suspense>
      ) : null}
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
