import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { useBotChatPersona } from '../../bots/bot-chat-persona'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatInstallHero } from './NativeChatInstallHero'
import type { NativeChatInstallSlotState } from './NativeChatInstallSlot'
import { useNativeChatTabOwnerWorktreeId } from '../pane/ownership/use-native-chat-tab-owner'

export function NativeChatEmptyPane(props: {
  slot: NativeChatInstallSlotState
  agent: AgentType
  tabId: string
}): React.JSX.Element {
  const { slot, agent } = props
  // A chat in a bot's home greets as the bot.
  const persona = useBotChatPersona(useNativeChatTabOwnerWorktreeId(props.tabId))
  return slot.kind === 'install' ? (
    <NativeChatInstallHero slot={slot} agentLabel={structuredAgentLabel(agent)} />
  ) : (
    <NativeChatEmptyState kind="empty" agent={agent} persona={persona} />
  )
}
