import { useCallback, useMemo, type JSX } from 'react'
import { Archive } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { Worktree } from '../../../../shared/worktree/types'
import { isArchivableWorktree, runArchiveWorktrees } from './archive-worktree-flow'

type WorkspaceArchiveMenuItemProps = {
  contextWorktrees: readonly Worktree[]
  disabled: boolean
  onMenuClose: () => void
}

function getArchiveMenuLabel(isMultiContext: boolean, archivableCount: number): string {
  if (!isMultiContext || archivableCount === 0) {
    return translate('auto.components.sidebar.WorktreeContextMenu.archive', 'Archive')
  }
  if (archivableCount === 1) {
    return translate(
      'auto.components.sidebar.WorktreeContextMenu.archiveOne',
      'Archive 1 Workspace'
    )
  }
  return translate(
    'auto.components.sidebar.WorktreeContextMenu.archiveMany',
    'Archive {{value0}} Workspaces',
    { value0: archivableCount }
  )
}

export function WorkspaceArchiveMenuItem({
  contextWorktrees,
  disabled,
  onMenuClose
}: WorkspaceArchiveMenuItemProps): JSX.Element | null {
  const isMultiContext = contextWorktrees.length > 1
  const archivableIds = useMemo(
    () => contextWorktrees.filter(isArchivableWorktree).map((item) => item.id),
    [contextWorktrees]
  )
  const handleArchiveSelect = useCallback(() => {
    onMenuClose()
    // Let Radix tear down before archiving remounts the virtualized sidebar.
    window.setTimeout(() => void runArchiveWorktrees(archivableIds), 50)
  }, [archivableIds, onMenuClose])

  // Why: primary checkouts and folder workspaces can't be archived; a dead row adds noise.
  if (!isMultiContext && archivableIds.length === 0) {
    return null
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuItem
          onSelect={handleArchiveSelect}
          disabled={disabled || archivableIds.length === 0}
        >
          <Archive className="size-3.5" />
          {getArchiveMenuLabel(isMultiContext, archivableIds.length)}
        </DropdownMenuItem>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-[220px]">
        {translate(
          'auto.components.sidebar.WorktreeContextMenu.archiveDescription',
          'Sleep and hide from the sidebar without deleting the worktree or branch. Restore it from Workspace options → Archived.'
        )}
      </TooltipContent>
    </Tooltip>
  )
}
