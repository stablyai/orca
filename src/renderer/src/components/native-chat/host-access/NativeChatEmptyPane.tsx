import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import { useBotChatPersona } from '../../bots/bot-chat-persona'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatRetainedWorkerChats } from './NativeChatRetainedWorkerChats'
import { NativeChatInstallHero } from './NativeChatInstallHero'
import type { NativeChatInstallSlotState } from './NativeChatInstallSlot'
import type { NativeChatStructuredViewProps } from '../native-chat-view-types'
import { useNativeChatTabOwnerWorktreeId } from '../pane/ownership/use-native-chat-tab-owner'

export function NativeChatEmptyPane(props: {
  slot: NativeChatInstallSlotState
  pane: Pick<NativeChatStructuredViewProps, 'agent' | 'tabId' | 'target' | 'isVisible'>
}): React.JSX.Element {
  const { slot, pane } = props
  const { agent } = pane
  const worktreeId = useNativeChatTabOwnerWorktreeId(pane.tabId)
  // A chat in a bot's home greets as the bot.
  const persona = useBotChatPersona(worktreeId)
  const retained = (
    <NativeChatRetainedWorkerChats
      worktreeId={worktreeId}
      target={pane.target}
      visible={pane.isVisible}
    />
  )
  return slot.kind === 'install' ? (
    <NativeChatInstallHero slot={slot} agentLabel={structuredAgentLabel(agent)}>
      {retained}
    </NativeChatInstallHero>
  ) : (
    <NativeChatEmptyState kind="empty" agent={agent} persona={persona}>
      {retained}
    </NativeChatEmptyState>
  )
}
