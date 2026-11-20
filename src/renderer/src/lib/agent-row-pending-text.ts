import type { AgentDotState } from '@/components/agent/status/AgentStateDot'
import { translate } from '@/i18n/i18n'

// Why dsh parity: a row waiting on the user names what it needs in the
// trailing cell instead of when it last moved. One copy so the sidebar
// compact row and the dashboard row cannot drift on a new pending member.
export function getAgentRowPendingText(state: AgentDotState): string | null {
  // If-chain (not switch) so adding a future AgentDotState member cannot
  // silently fall through: only these three states name what they need.
  if (state === 'waiting') {
    return translate('auto.components.sidebar.CompactAgentRow.pendingWaiting', 'Waiting for input')
  }
  if (state === 'blocked') {
    return translate('auto.components.sidebar.CompactAgentRow.pendingBlocked', 'Blocked')
  }
  if (state === 'permission') {
    return translate('auto.components.sidebar.CompactAgentRow.pendingPermission', 'Needs attention')
  }
  return null
}
