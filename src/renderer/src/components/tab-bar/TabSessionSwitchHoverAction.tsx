import {
  useConversationSwitchBusy,
  useConversationSwitchReadiness,
  runCliChatResume,
  runNativeChatCliSwitch
} from '@/lib/conversation-surface-switch'
import { useShallow } from 'zustand/react/shallow'
import { Loader2, MessagesSquare, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useInPlaceSwitchCapability } from '@/lib/in-place-switch-support'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import { resolveCliChatResumeSource } from './cli-chat-resume-source'
import {
  resolveNativeChatCliForkIdentity,
  type NativeChatTabSession
} from './tab-session-history-switch'

/** The tab's in-place switch inside its hover card; mounted only while the card is open. */
export function TabSessionSwitchHoverAction({
  tab,
  nativeChat
}: {
  tab: { id: string; worktreeId: string }
  nativeChat?: NativeChatTabSession
}): React.JSX.Element | null {
  return nativeChat ? (
    <ChatSwitchAction tab={tab} nativeChat={nativeChat} />
  ) : (
    <TerminalSwitchAction tab={tab} />
  )
}

function ChatSwitchAction({
  tab,
  nativeChat
}: {
  tab: { id: string; worktreeId: string }
  nativeChat: NativeChatTabSession
}): React.JSX.Element | null {
  const chat = useAppStore(
    useShallow((state) => resolveNativeChatCliForkIdentity(state, { tab, nativeChat }))
  )
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === nativeChat.agent)
  const inPlace = useInPlaceSwitchCapability(chat?.executionHostScope, agent)
  const readiness = useConversationSwitchReadiness(
    chat && agent
      ? {
          direction: 'terminal',
          sessionId: chat.sessionId,
          agent,
          workspaceId: chat.workspaceId,
          executionHostId: chat.executionHostScope,
          chatTabId: tab.id
        }
      : null
  )
  const busy = useConversationSwitchBusy(readiness.pending)

  if (!chat || !agent || inPlace === false) {
    return null
  }
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={!readiness.ready}
      title={readiness.explanation}
      onClick={() =>
        void runNativeChatCliSwitch({
          sessionId: chat.sessionId,
          workspaceId: chat.workspaceId,
          executionHostId: chat.executionHostScope,
          agent,
          chatTabId: tab.id
        })
      }
    >
      {busy ? <Loader2 className="animate-spin" /> : <SquareTerminal />}
      {translate('components.tab.bar.switch.toCli', 'Switch to CLI')}
    </Button>
  )
}

function TerminalSwitchAction({
  tab
}: {
  tab: { id: string; worktreeId: string }
}): React.JSX.Element | null {
  const source = useAppStore(useShallow((state) => resolveCliChatResumeSource(state, { tab })))
  const inPlace = useInPlaceSwitchCapability(source?.executionHostId, source?.agent)
  const readiness = useConversationSwitchReadiness(
    source ? { direction: 'chat', ...source, source } : null
  )
  const busy = useConversationSwitchBusy(readiness.pending)

  if (!source || inPlace === false) {
    return null
  }
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={!readiness.ready}
      title={readiness.explanation}
      onClick={() => void runCliChatResume(source)}
    >
      {busy ? <Loader2 className="animate-spin" /> : <MessagesSquare />}
      {translate('components.tab.bar.switch.toNativeChat', 'Switch to Chat UI')}
    </Button>
  )
}
