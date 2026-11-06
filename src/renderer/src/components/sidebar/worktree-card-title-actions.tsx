import React from 'react'
import { AlertCircle, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { WorktreeCardController } from './workspace-card/controller/use-worktree-card-controller'

export function WorktreeCardRenameFailedButton({
  card
}: {
  card: WorktreeCardController
}): React.JSX.Element | null {
  const {
    worktree,
    titleRenaming,
    stopQuickActionPointerPropagation,
    handleOpenRenameErrorDialog
  } = card
  if (
    typeof worktree.firstAgentMessageRenameError !== 'string' ||
    worktree.firstAgentMessageRenameError.length === 0 ||
    titleRenaming
  ) {
    return null
  }
  // Errors can contain raw agent output; open a dialog rather than a tooltip.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          onPointerDown={stopQuickActionPointerPropagation}
          onClick={handleOpenRenameErrorDialog}
          onDoubleClick={handleOpenRenameErrorDialog}
          className="h-4 shrink-0 gap-0.5 rounded !px-0.5 text-[10px] font-medium leading-none text-destructive border border-destructive/40 bg-destructive/10 hover:bg-destructive/15 hover:text-destructive has-[>svg]:!px-0.5"
          aria-label={translate(
            'auto.components.sidebar.WorktreeCard.02e19349f4',
            'Auto-rename failed: view error'
          )}
        >
          <AlertCircle className="size-2.5" />
          {translate('auto.components.sidebar.WorktreeCard.74522ee457', 'rename failed')}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {translate(
          'auto.components.sidebar.WorktreeCard.4eba2ea99e',
          'Auto-name failed. Click to see details.'
        )}
      </TooltipContent>
    </Tooltip>
  )
}

export function WorktreeCardDeleteQuickAction({
  card
}: {
  card: WorktreeCardController
}): React.JSX.Element {
  const { stopQuickActionPointerPropagation, handleWorkspaceQuickAction } = card
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-workspace-board-preserve-open=""
          onPointerDown={stopQuickActionPointerPropagation}
          onClick={handleWorkspaceQuickAction}
          className={cn(
            'inline-flex size-4 items-center justify-center rounded bg-transparent opacity-0 transition-colors transition-opacity',
            'group-hover/worktree-card:opacity-100 group-focus-within/worktree-card:opacity-100 focus-visible:opacity-100',
            'text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive'
          )}
          aria-label={translate(
            'auto.components.sidebar.WorktreeCard.6f09f58541',
            'Delete workspace'
          )}
        >
          <Trash2 className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {translate('auto.components.sidebar.WorktreeCard.6f09f58541', 'Delete workspace')}
      </TooltipContent>
    </Tooltip>
  )
}
