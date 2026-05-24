import React from 'react'
import { getWorktreeStatusLabel } from '@/lib/worktree-status'
import { cn } from '@/lib/utils'
import StatusIndicator from './StatusIndicator'
import { useFocusedAgentStatusHighlight } from './focused-agent-status-highlight'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'

export function WorktreeActivityStatusIndicator({
  worktreeId,
  className
}: {
  worktreeId: string
  className?: string
}): React.JSX.Element {
  const status = useWorktreeActivityStatus(worktreeId)
  const isFocusedAgentPane = useFocusedAgentStatusHighlight(worktreeId)
  const label = getWorktreeStatusLabel(status)

  return (
    <>
      <StatusIndicator
        status={status}
        aria-hidden="true"
        data-focused-agent-pane={isFocusedAgentPane ? 'true' : undefined}
        className={cn(
          className,
          isFocusedAgentPane &&
            'rounded-full ring-2 ring-[var(--terminal-pane-locate)] ring-offset-1 ring-offset-[var(--sidebar)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--terminal-pane-locate)_20%,transparent),0_0_12px_color-mix(in_srgb,var(--terminal-pane-locate)_42%,transparent)] transition-[box-shadow,outline-color,background-color] duration-150'
        )}
      />
      <span className="sr-only">{isFocusedAgentPane ? `Focused agent pane, ${label}` : label}</span>
    </>
  )
}
