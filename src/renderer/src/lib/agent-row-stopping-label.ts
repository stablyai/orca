import { agentStopDisplayStatus } from '../../../shared/agent-status/lifecycle/agent-stop-display-status'
import type { AgentStatusEntry } from '../../../shared/agent-status/contracts/agent-status-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { AgentRowState } from '../../../shared/agent-status/presentation/agent-row-decay-state'

/** Replace the last tool line with Stopping… while a user-requested stop ends a working turn. */
export function agentRowStoppingLabel(
  entry: Pick<AgentStatusEntry, 'mainAgent'>,
  state: AgentRowState | null | undefined,
  t: Translate = translate
): string | null {
  const display = agentStopDisplayStatus({
    working: state === 'working',
    hostStopping: entry.mainAgent?.stopping === true
  })
  return display === 'stopping' ? t('components.native-chat.status.stopping', 'Stopping…') : null
}
