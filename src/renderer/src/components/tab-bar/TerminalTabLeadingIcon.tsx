import { AgentStateDot, agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { TerminalTab, TuiAgent } from '../../../../shared/types'
import { FilledBellIcon } from '../sidebar/WorktreeCardHelpers'
import { ShellIcon } from './shell-icons'
import type {
  TerminalTabActivityStatus,
  TerminalTabUnreadKind
} from './terminal-tab-activity-status'
import { translate } from '@/i18n/i18n'

type TerminalTabLeadingIconProps = {
  agent: TuiAgent | null
  activityAgent?: TuiAgent | null
  unreadAgent?: TuiAgent | null
  unreadKind: TerminalTabUnreadKind | null
  activityStatus: TerminalTabActivityStatus
  shell: TerminalTab['shellOverride']
  showUnreadActivity: boolean
  isActive: boolean
}

type TerminalTabAgentIdentityIconProps = {
  agent: TuiAgent
  className?: string
}

function providerStatusLabel(agent: TuiAgent | null, statusLabel: string): string {
  return agent ? `${getAgentLabel(agent)} · ${statusLabel}` : statusLabel
}

/**
 * Map the container status to the shared state-dot vocabulary. `active` and
 * `inactive` carry no activity glyph — the tab falls through to its agent or
 * shell identity icon instead. Uses the same WorktreeStatus vocabulary as the
 * sidebar so live states read identically (tabs intentionally omit the card's
 * retained-done promotion, so a stale green check can differ after cleanup).
 */
function activityDotState(status: TerminalTabActivityStatus): AgentDotState | null {
  switch (status) {
    case 'working':
      return 'working'
    case 'permission':
      return 'permission'
    case 'done':
      return 'done'
    case 'blocked':
      return 'blocked'
    case 'interrupted':
      return 'interrupted'
    case 'active':
    case 'inactive':
      return null
  }
}

/** Keep the provider glyph treatment identical across every terminal-tab state. */
function TerminalTabAgentIdentityIcon({
  agent,
  className
}: TerminalTabAgentIdentityIconProps): React.JSX.Element {
  return (
    <span className={cn('inline-flex', className)} data-agent-icon={agent} aria-hidden>
      <AgentIcon agent={agent} size={12} />
    </span>
  )
}

/** Render a tab state with provider identity only when ownership is truthful. */
export function TerminalTabLeadingIcon({
  agent,
  activityAgent,
  unreadAgent,
  unreadKind,
  activityStatus,
  shell,
  showUnreadActivity,
  isActive
}: TerminalTabLeadingIconProps): React.JSX.Element {
  const dotState = activityDotState(activityStatus)
  // Why: the tab state aggregates every split pane, while `agent` describes
  // the focused pane. Use the winning/unread pane provider when unique; an
  // explicit null intentionally yields truthful provider-neutral copy.
  const displayedAgent = showUnreadActivity
    ? unreadAgent === undefined
      ? agent
      : unreadAgent
    : dotState
      ? activityAgent === undefined
        ? agent
        : activityAgent
      : agent

  if (showUnreadActivity) {
    const unreadLabel =
      unreadKind === 'agent-completion'
        ? translate(
            'auto.components.tab.bar.TerminalTabLeadingIcon.7ab2964bea',
            'Unread agent completion'
          )
        : translate(
            'auto.components.tab.bar.TerminalTabLeadingIcon.unreadTerminalActivity',
            'Unread terminal activity'
          )
    const label = providerStatusLabel(displayedAgent, unreadLabel)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="tab-activity-bell"
            data-unread-kind={unreadKind ?? undefined}
            role="img"
            aria-label={label}
            className={cn(
              'mr-1 inline-flex shrink-0 items-center',
              (displayedAgent || agent) && 'w-7 gap-1'
            )}
          >
            <FilledBellIcon className="size-3 text-status-attention drop-shadow-sm" />
            {displayedAgent ? (
              <TerminalTabAgentIdentityIcon agent={displayedAgent} />
            ) : agent ? (
              // Why: mixed provider ownership requires neutral copy, but the
              // identity slot stays reserved so the tab title never jumps.
              <span className="size-3 shrink-0" aria-hidden />
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (dotState) {
    const label = providerStatusLabel(displayedAgent, agentStateLabel(dotState))
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="tab-agent-activity-indicator"
            data-agent-activity-status={activityStatus}
            role="img"
            aria-label={label}
            className={cn(
              'mr-1 inline-flex shrink-0 items-center',
              (displayedAgent || agent) && 'w-7 gap-1'
            )}
          >
            <AgentStateDot state={dotState} size="md" aria-hidden="true" />
            {/* Why: status and identity answer different questions. Show the
                provider only when every winning pane agrees on its owner. */}
            {displayedAgent ? (
              <TerminalTabAgentIdentityIcon agent={displayedAgent} />
            ) : agent ? (
              <span className="size-3 shrink-0" aria-hidden />
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (displayedAgent) {
    const label = getAgentLabel(displayedAgent)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="mr-1 inline-flex w-7 shrink-0 items-center gap-1"
            role="img"
            aria-label={label}
          >
            {/* Why: reserve the status column so the title never shifts when this
                quiet tab starts working, needs attention, or completes. */}
            <span className="size-3 shrink-0" aria-hidden />
            <TerminalTabAgentIdentityIcon agent={displayedAgent} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
    )
  }

  // Why: ShellIcon renders a colored brand-style tile for PowerShell, CMD,
  // Git Bash, and WSL while retaining the generic terminal fallback elsewhere.
  return (
    <span
      className={`mr-1 inline-flex shrink-0 ${isActive ? '' : 'opacity-70'}`}
      data-shell-icon={shell ?? 'generic'}
      aria-hidden
    >
      <ShellIcon shell={shell} size={12} />
    </span>
  )
}
