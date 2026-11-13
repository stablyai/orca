import { AgentStateDot } from '@/components/AgentStateDot'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { cn } from '@/lib/class-names'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import '../sidebar/workspace-card/activity/worktree-card-empty-inputs'
import { FilledBellIcon } from '../sidebar/workspace-card/identity/worktree-card-glyphs'
import { ShellIcon } from './shell-icons'
import {
  terminalTabActivityToAgentDotState,
  type TerminalTabActivityStatus
} from './terminal-tab-activity-status'
import { useTranslate } from '@/i18n/use-translate'

type TerminalTabLeadingIconProps = {
  agent: TerminalAgent | null
  activityStatus: TerminalTabActivityStatus
  shell: TerminalTab['shellOverride']
  showUnreadActivity: boolean
  isActive: boolean
  /** Program-reported 0–100 for the tab's live work; fills the state ring. */
  progress?: number
  /** Icon-only slot: identity icon with the bell or state as a corner badge, so 32px fits. */
  compact?: boolean
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
  progress,
  compact = false
}: TerminalTabLeadingIconProps): React.JSX.Element {
  const t = useTranslate()
  if (compact) {
    const dotState = showUnreadActivity ? null : terminalTabActivityToAgentDotState(activityStatus)
    return (
      <span
        className="relative inline-flex shrink-0"
        data-testid={showUnreadActivity ? 'tab-activity-bell' : undefined}
        aria-label={
          showUnreadActivity
            ? t(
                'auto.components.tab.bar.TerminalTabLeadingIcon.7ab2964bea',
                'Unread agent completion'
              )
            : undefined
        }
      >
        {agent ? (
          <TerminalTabAgentIdentityIcon agent={agent} isActive={isActive} />
        ) : (
          <span className={`inline-flex ${isActive ? '' : 'opacity-70'}`} aria-hidden>
            <ShellIcon shell={shell} size={12} />
          </span>
        )}
        {showUnreadActivity ? (
          <span
            aria-hidden
            className="absolute -right-1 -top-1 size-1.5 rounded-full bg-amber-500 ring-1 ring-tab-inactive"
          />
        ) : dotState ? (
          <span
            className="absolute -right-1.5 -top-1.5 inline-flex"
            data-testid="tab-agent-activity-indicator"
            data-agent-activity-status={activityStatus}
          >
            <AgentStateDot state={dotState} size="sm" title={null} progress={progress} />
          </span>
        ) : null}
      </span>
    )
  }
  if (showUnreadActivity) {
    return (
      <span
        data-testid="tab-activity-bell"
        aria-label={t(
          'auto.components.tab.bar.TerminalTabLeadingIcon.7ab2964bea',
          'Unread agent completion'
        )}
        className="mr-1 inline-flex shrink-0 items-center gap-1"
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
        className="mr-1 inline-flex shrink-0 items-center gap-1"
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
      <TerminalTabAgentIdentityIcon agent={agent} isActive={isActive} className="mr-1 shrink-0" />
    )
  }

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
