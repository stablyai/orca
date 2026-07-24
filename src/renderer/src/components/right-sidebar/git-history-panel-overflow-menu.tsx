import type React from 'react'
import { List, ListTree, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { SourceControlViewMode } from '../../../../shared/types'

// Why: commit-file layout is infrequent and scoped to expanded rows, so keep it in overflow.
export function GitHistoryPanelOverflowMenu({
  commitFilesViewMode,
  viewModeToggleDisabled,
  onToggleViewMode
}: {
  commitFilesViewMode: SourceControlViewMode
  viewModeToggleDisabled: boolean
  onToggleViewMode: () => void
}): React.JSX.Element {
  const viewModeLabel =
    commitFilesViewMode === 'tree'
      ? translate('auto.components.right.sidebar.SourceControl.a91f8e2b01', 'View as list')
      : translate('auto.components.right.sidebar.SourceControl.b82e9f3c12', 'View as tree')

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="h-auto w-auto p-0.5 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent [&_svg]:size-3"
              aria-label={translate(
                'auto.components.right.sidebar.GitHistoryPanel.5e4f2a9c81',
                'More commit history actions'
              )}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate(
            'auto.components.right.sidebar.GitHistoryPanel.5e4f2a9c81',
            'More commit history actions'
          )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        <DropdownMenuItem disabled={viewModeToggleDisabled} onSelect={onToggleViewMode}>
          {commitFilesViewMode === 'tree' ? (
            <List className="size-3.5" />
          ) : (
            <ListTree className="size-3.5" />
          )}
          {viewModeLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
