import { agentStopDisplayStatus } from '../../../shared/agent-stop-display-status'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { translate } from '@/i18n/i18n'
import type { AgentRowState } from '../../../shared/agent-row-decay-state'

/** Replace the last tool line with Stopping… while a user-requested stop ends a working turn. */
export function agentRowStoppingLabel(
  entry: Pick<AgentStatusEntry, 'mainAgent'>,
  state: AgentRowState | null | undefined
): string | null {
  const display = agentStopDisplayStatus({
    working: state === 'working',
    hostStopping: entry.mainAgent?.stopping === true
  })
  return display === 'stopping'
    ? translate('components.native-chat.status.stopping', 'Stopping…')
    : null
}
