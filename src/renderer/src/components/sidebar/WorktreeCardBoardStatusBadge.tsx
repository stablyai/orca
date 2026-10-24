import React from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../shared/worktree/types'
import { resolveWorktreeCardBoardStatus } from './worktree-card-board-status'
import { getWorkspaceStatusVisualMeta } from './workspace-status'

export function WorktreeCardBoardStatusBadge({
  worktree,
  iconOnly
}: {
  worktree: Pick<Worktree, 'workspaceStatus'>
  iconOnly: boolean
}): React.JSX.Element | null {
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const groupBy = useAppStore((s) => s.groupBy)
  const status = resolveWorktreeCardBoardStatus(worktree, workspaceStatuses, groupBy)
  if (!status) {
    return null
  }
  const meta = getWorkspaceStatusVisualMeta(status)
  const tooltip = translate(
    'auto.components.sidebar.WorktreeCard.boardStatusTooltip',
    'Board status: {{value0}}',
    { value0: status.label }
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="worktree-card-board-status"
          aria-label={tooltip}
          className={cn(
            'inline-flex h-4 max-w-24 shrink-0 items-center gap-0.5 rounded-[4px] border border-worktree-sidebar-border bg-worktree-sidebar-accent/55 px-0.5',
            meta.tone
          )}
        >
          <meta.icon className="size-3 shrink-0" />
          {!iconOnly && (
            <span className="min-w-0 truncate text-3xs leading-none lowercase">{status.label}</span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
