import { useState } from 'react'
import { Ellipsis, FolderSearch, Trash2 } from 'lucide-react'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { translate } from '@/i18n/i18n'
import { getRevealInFileManagerLabel, revealInFileManager } from '@/lib/reveal-in-file-manager'
import { Button } from '../ui/button'
import { ContextMenuItem } from '../ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

type WorkspaceSpaceWorktreeActionProps = {
  worktree: WorkspaceSpaceWorktree
  canDelete: boolean
  canOpenWorkspace: boolean
  isDeleting: boolean
  onDelete: () => void
}

export function WorkspaceSpaceWorktreeMenuItems({
  worktree,
  canDelete,
  canOpenWorkspace,
  isDeleting,
  onDelete,
  context = false
}: WorkspaceSpaceWorktreeActionProps & { context?: boolean }): React.JSX.Element {
  const Item = context ? ContextMenuItem : DropdownMenuItem
  return (
    <>
      <Item
        onSelect={() =>
          void revealInFileManager(worktree.path, worktree.executionHostId ?? 'unresolved')
        }
      >
        <FolderSearch className="size-3.5" />
        {getRevealInFileManagerLabel()}
      </Item>
      <Item variant="destructive" disabled={!canDelete} onSelect={onDelete}>
        <Trash2 className="size-3.5" />
        {translate(
          'auto.components.status.bar.WorkspaceSpaceManagerPanel.792a214457',
          'Delete workspace'
        )}
      </Item>
      {!canDelete ? (
        <div className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
          {isDeleting
            ? translate('workspaceSpace.delete.pending', 'Deletion is in progress.')
            : worktree.isMainWorktree
              ? translate('workspaceSpace.delete.main', 'The main worktree is protected.')
              : !canOpenWorkspace
                ? translate(
                    'workspaceSpace.delete.unmanaged',
                    'This workspace is no longer managed by Orca.'
                  )
                : translate(
                    'workspaceSpace.delete.unavailable',
                    'This workspace is protected or unavailable.'
                  )}
        </div>
      ) : null}
    </>
  )
}

export function WorkspaceSpaceWorktreeActions(
  props: WorkspaceSpaceWorktreeActionProps
): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const label = translate('workspaceSpace.rowActions', 'Actions for {{name}}', {
    name: props.worktree.displayName
  })
  return (
    <DropdownMenu onOpenChange={setMenuOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={label}
              onClick={(event) => event.stopPropagation()}
            >
              <Ellipsis className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {!menuOpen ? <TooltipContent>{label}</TooltipContent> : null}
      </Tooltip>
      <DropdownMenuContent align="end">
        <WorkspaceSpaceWorktreeMenuItems {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
