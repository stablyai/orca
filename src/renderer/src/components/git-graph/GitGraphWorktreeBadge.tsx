import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getWorktreeStatusLabel } from '@/lib/worktree-status'
import { useWorktreeActivityStatus } from '@/components/sidebar/use-worktree-activity-status'
import StatusIndicator from '@/components/sidebar/StatusIndicator'
import { translate } from '@/i18n/i18n'
import type { GitGraphWorktreeOverlayEntry } from './git-graph-worktree-overlay'

// The graph's Orca differentiator: branches with a workspace show a live
// activity dot and jump straight to that worktree on click.
export function GitGraphWorktreeBadge({
  entry
}: {
  entry: GitGraphWorktreeOverlayEntry
}): React.JSX.Element {
  const activity = useWorktreeActivityStatus(entry.worktreeId)
  const workspaceStatusLabel = useAppStore((s) => {
    if (!entry.workspaceStatus) {
      return null
    }
    return (
      s.workspaceStatuses.find((candidate) => candidate.id === entry.workspaceStatus)?.label ?? null
    )
  })

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex max-w-[10rem] shrink-0 items-center gap-1 rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] leading-none text-foreground transition-colors hover:bg-accent"
          aria-label={translate(
            'auto.components.git.graph.GitGraphWorktreeBadge.openWorktree',
            'Open worktree {{value0}}',
            { value0: entry.displayName }
          )}
          onClick={(event) => {
            event.stopPropagation()
            activateAndRevealWorktree(entry.worktreeId)
          }}
        >
          <StatusIndicator status={activity} aria-hidden="true" />
          <span className="truncate">{entry.displayName}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
        <div className="font-medium">{entry.displayName}</div>
        <div>
          {entry.isActiveWorkspace
            ? translate(
                'auto.components.git.graph.GitGraphWorktreeBadge.currentWorkspace',
                'Current workspace'
              )
            : getWorktreeStatusLabel(activity)}
          {workspaceStatusLabel ? ` · ${workspaceStatusLabel}` : ''}
        </div>
        {!entry.isActiveWorkspace && (
          <div className="text-background/70">
            {translate(
              'auto.components.git.graph.GitGraphWorktreeBadge.clickToOpen',
              'Click to open this worktree'
            )}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
