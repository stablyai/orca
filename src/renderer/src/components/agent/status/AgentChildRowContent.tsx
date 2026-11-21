import React from 'react'
import type { AgentChildRowModel } from '../../../../../shared/agent-status/presentation/agent-child-row-model'
import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import type { StateIndicatorTooltipSide } from '@/components/agent/status/StateIndicatorTooltip'
import { agentChildRowText } from './agent-child-row-text'

type AgentChildRowContentProps = {
  row: AgentChildRowModel
  now: number
  /** Surface tone for the name and the detail; the words themselves are the row's. */
  leadClassName: string
  trailClassName: string
  separator: string
  /** Overrides the dot's hover label; null suppresses it for an existing tooltip. */
  dotTitle?: string | null
  tooltipSide?: StateIndicatorTooltipSide
  /** Name the whole line on hover, for surfaces that truncate it tightly. */
  lineTitle?: boolean
  /** After the state dot, where rows of several kinds mix and each shows its kind's icon there. */
  icon?: React.ReactNode
  /** A kind label after the name, such as "Subagent" where rows of several kinds mix. */
  badge?: React.ReactNode
}

/** Keep sidebar-child and chat-strip state/name/detail rendering consistent. */
export const AgentChildRowContent = React.memo(function AgentChildRowContent({
  row,
  now,
  leadClassName,
  trailClassName,
  separator,
  dotTitle,
  tooltipSide,
  lineTitle = false,
  icon,
  badge
}: AgentChildRowContentProps): React.JSX.Element {
  const { lead, trail } = agentChildRowText(row, now)
  return (
    <>
      <AgentStateDot
        state={row.displayState}
        size="sm"
        title={dotTitle}
        tooltipSide={tooltipSide}
      />
      {icon}
      <span
        className="min-w-0 flex-1 truncate"
        title={lineTitle ? `${lead}${trail ? `${separator}${trail}` : ''}` : undefined}
      >
        <span className={leadClassName}>{lead}</span>
        {badge}
        {trail ? (
          <span className={trailClassName}>
            {separator}
            {trail}
          </span>
        ) : null}
      </span>
    </>
  )
})
