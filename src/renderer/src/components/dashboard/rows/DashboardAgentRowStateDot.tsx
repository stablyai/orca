import React from 'react'
import { AgentStateDot, type AgentDotState } from '@/components/AgentStateDot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  CloudAgentRowSignInDot,
  type CloudAgentRowStatusText
} from '@/components/orca-cloud/CloudAgentRowSignInTarget'
import { useHasWorktreeCardUnreadRollup } from '@/components/sidebar/workspace-card/surface/worktree-card-title-status'

/** The row's leading state dot; an Orca Cloud agent awaiting sign-in shows its Settings link instead. */
export function DashboardAgentRowStateDot({
  signIn,
  dotState,
  size,
  progress,
  unread,
  tooltipLabel
}: {
  signIn: CloudAgentRowStatusText | null
  dotState: AgentDotState
  size: 'sm' | 'md'
  progress: React.ComponentProps<typeof AgentStateDot>['progress']
  unread: boolean
  tooltipLabel: string
}): React.JSX.Element {
  const hasUnreadRollup = useHasWorktreeCardUnreadRollup()
  if (signIn) {
    return <CloudAgentRowSignInDot status={signIn} size={size} />
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 items-center justify-center"
          aria-label={tooltipLabel}
        >
          <AgentStateDot
            state={dotState}
            size={size}
            title={null}
            progress={progress}
            unread={unread}
            unreadDisplay={hasUnreadRollup ? 'label' : 'dot'}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {tooltipLabel}
      </TooltipContent>
    </Tooltip>
  )
}
