import { AgentStateDot } from '@/components/AgentStateDot'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TerminalAgent } from '../../../../shared/terminal-agent'
import { FilledBellIcon } from '../sidebar/WorktreeCardHelpers'
import { ShellIcon } from './shell-icons'
import {
  terminalTabActivityToAgentDotState,
  type TerminalTabActivityStatus
} from './terminal-tab-activity-status'
import { translate } from '@/i18n/i18n'

type TerminalTabLeadingIconProps = {
  agent: TerminalAgent | null
  activityStatus: TerminalTabActivityStatus
  shell: TerminalTab['shellOverride']
  showUnreadActivity: boolean
  isActive: boolean
  /** Program-reported 0–100 for the tab's live work; fills the state ring. */
  progress?: number
}

type TerminalTabAgentIdentityIconProps = {
  agent: TerminalAgent
  isActive: boolean
  className?: string
}

function TerminalTabAgentIdentityIcon({
  agent,
  isActive,
  className
}: TerminalTabAgentIdentityIconProps): React.JSX.Element {
  return (
    <span
      className={cn('inline-flex', !isActive && 'opacity-70', className)}
      data-agent-icon={agent}
      aria-hidden
    >
      <AgentIcon agent={agent} size={12} />
    </span>
  )
}

export function TerminalTabLeadingIcon({
  agent,
  activityStatus,
  shell,
  showUnreadActivity,
  isActive,
  progress
}: TerminalTabLeadingIconProps): React.JSX.Element {
  // Reserve activity and identity slots before agent detection as well as status changes.
  const iconClassName = 'mr-1 inline-flex w-7 shrink-0 items-center gap-1'
  if (showUnreadActivity) {
    return (
      <span
        data-testid="tab-activity-bell"
        aria-label={translate(
          'auto.components.tab.bar.TerminalTabLeadingIcon.7ab2964bea',
          'Unread agent completion'
        )}
        className={iconClassName}
      >
        <FilledBellIcon className="size-3 text-amber-500 drop-shadow-sm" />
        {agent ? <TerminalTabAgentIdentityIcon agent={agent} isActive={isActive} /> : null}
      </span>
    )
  }

  // Share activity mapping with recent-tab badges; idle states retain agent/shell identity.
  const dotState = terminalTabActivityToAgentDotState(activityStatus)
  if (dotState) {
    return (
      <span
        data-testid="tab-agent-activity-indicator"
        data-agent-activity-status={activityStatus}
        className={iconClassName}
      >
        {/* Why: the state glyph is self-describing and the tab title already has a tooltip; hover here stays quiet. */}
        <AgentStateDot state={dotState} size="md" title={null} progress={progress} />
        {/* Keep agent identity beside activity so parallel tabs remain distinguishable. */}
        {agent ? <TerminalTabAgentIdentityIcon agent={agent} isActive={isActive} /> : null}
      </span>
    )
  }

  if (agent) {
    return (
      <TerminalTabAgentIdentityIcon
        agent={agent}
        isActive={isActive}
        className={cn(iconClassName, 'justify-end')}
      />
    )
  }

  return (
    <span
      className={cn(iconClassName, !isActive && 'opacity-70')}
      data-shell-icon={shell ?? 'generic'}
      aria-hidden
    >
      <ShellIcon shell={shell} size={12} />
    </span>
  )
}
