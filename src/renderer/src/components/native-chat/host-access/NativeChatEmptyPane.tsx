import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatInstallHero } from './NativeChatInstallHero'
import type { NativeChatInstallSlotState } from './NativeChatInstallSlot'
import type { NativeChatSessionHistory } from './use-native-chat-session-history'

export function NativeChatEmptyPane(props: {
  slot: NativeChatInstallSlotState
  agent: AgentType
  history?: NativeChatSessionHistory
}): React.JSX.Element {
  const { slot, agent, history } = props
  return slot.kind === 'install' ? (
    <NativeChatInstallHero slot={slot} agentLabel={structuredAgentLabel(agent)} />
  ) : (
    <NativeChatEmptyState kind="empty" agent={agent} history={history} />
  )
}
