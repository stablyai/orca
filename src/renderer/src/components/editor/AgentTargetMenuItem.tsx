import React from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
import { AgentIcon } from '@/lib/agent-catalog'
import { formatAgentTypeLabel, agentTypeToIconAgent } from '@/lib/agent-status'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { agentRowDotState } from '@/lib/agent-row-dot-state'
import type { NotesSendAgentTarget } from '@/lib/notes-send-agent-targets'
import { formatAgentRelativeTime } from './review-notes-send-menu-helpers'

export function AgentTargetMenuItem({
  target,
  agent,
  terminalIndex,
  tabColor,
  now,
  disabled,
  onSend
}: {
  target: NotesSendAgentTarget
  agent: DashboardAgentRowData | null
  terminalIndex?: number
  tabColor?: string | null
  now: number
  disabled: boolean
  onSend: (target: NotesSendAgentTarget) => void
}): React.JSX.Element {
  const tabTitle = target.tabTitle.trim()
  const state = agentRowDotState(agent?.state ?? 'idle', agent?.entry.workingMode)
  const timeAgo = agent ? formatAgentRelativeTime(agent, now) : null
  const disabledReason = target.status === 'disabled' ? target.disabledReason : undefined
  const secondaryParts = [
    agentStateLabel(state),
    ...(timeAgo ? [timeAgo] : []),
    ...(tabTitle ? [tabTitle] : [])
  ]
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={() => onSend(target)}
      // Why: surface the ineligibility reason (permission/stale/no-terminal) as a
      // hover tooltip rather than inline text, matching DashboardAgentRow's
      // title-attribute treatment of the same disabledReason.
      title={disabledReason}
      className="min-w-[240px] gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
    >
      {/* Why: the ancestor's actionable disabled reason must win on every hit area. */}
      <AgentStateDot
        state={state}
        size="sm"
        className="shrink-0"
        title={disabledReason ? null : undefined}
      />
      <AgentIcon agent={agentTypeToIconAgent(target.agentType ?? agent?.agentType)} size={14} />
      <span className="grid min-w-0 flex-1 text-left">
        <span className="flex items-center gap-1.5 truncate">
          {terminalIndex !== undefined && (
            <span
              data-testid="agent-menu-terminal-index"
              data-terminal-index={String(terminalIndex)}
              className="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-mono font-medium text-muted-foreground bg-muted/60 shrink-0"
              style={
                tabColor
                  ? {
                      color: tabColor,
                      backgroundColor: `color-mix(in srgb, ${tabColor} 15%, transparent)`,
                      boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tabColor} 40%, transparent)`
                    }
                  : undefined
              }
            >
              #{terminalIndex}
            </span>
          )}
          <span className="truncate">
            {formatAgentTypeLabel(target.agentType ?? agent?.agentType)}
          </span>
        </span>
        <span className="truncate text-[11px] font-normal text-muted-foreground">
          {secondaryParts.join(' · ')}
        </span>
      </span>
    </DropdownMenuItem>
  )
}
