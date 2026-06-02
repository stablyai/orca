import type { JSX } from 'react'
import { AgentIcon } from '@/lib/agent-catalog'
import type { TuiAgent } from '../../../../shared/types'
import { FilledBellIcon } from '../sidebar/WorktreeCardHelpers'

type TerminalTabAgentIconProps = {
  agent: TuiAgent
  isActive: boolean
  showWorkingBadge: boolean
  showDoneBadge: boolean
}

export function TerminalTabAgentIcon({
  agent,
  isActive,
  showWorkingBadge,
  showDoneBadge
}: TerminalTabAgentIconProps): JSX.Element {
  return (
    <span className="mr-1 inline-flex shrink-0" data-agent-icon={agent} aria-hidden>
      <span className="relative inline-flex">
        <span className={isActive ? undefined : 'opacity-70'}>
          <AgentIcon agent={agent} size={12} />
        </span>
        {showWorkingBadge && (
          // Why: attach activity to the provider glyph so long tab titles do
          // not shift or gain another leading adornment when status changes.
          <span
            data-testid="tab-working-agent-badge"
            className="absolute -bottom-0.5 -right-0.5 inline-flex size-2 items-center justify-center rounded-full bg-card"
          >
            <span className="block size-2 rounded-full border-2 border-yellow-500 border-t-transparent animate-spin" />
          </span>
        )}
        {showDoneBadge &&
          !showWorkingBadge && (
            // Why: completed agents should keep their provider identity visible;
            // the bell overlays the glyph and clears with the existing unread-tab state.
            <span
              data-testid="tab-done-agent-badge"
              className="absolute -bottom-0.5 -right-0.5 inline-flex size-2.5 items-center justify-center rounded-full bg-card"
            >
              <FilledBellIcon className="size-2 text-amber-500 drop-shadow-sm" />
            </span>
          )}
      </span>
    </span>
  )
}
