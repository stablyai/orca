import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
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
import { inPlaceSwitchEnabled } from '../../../../shared/structured-agent-cli-conversation-adoption'
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
  const confirm = useConfirmationDialog()
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

  if (!chat || !agent || !inPlaceSwitchEnabled(agent)) {
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
          confirm,
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
  const confirm = useConfirmationDialog()
  const readiness = useConversationSwitchReadiness(
    source ? { direction: 'chat', ...source, source } : null
  )
  const busy = useConversationSwitchBusy(readiness.pending)

  if (!source || !inPlaceSwitchEnabled(source.agent)) {
    return null
  }
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={!readiness.ready}
      title={readiness.explanation}
      onClick={() => void runCliChatResume(source, confirm)}
    >
      {busy ? <Loader2 className="animate-spin" /> : <MessagesSquare />}
      {translate('components.tab.bar.switch.toNativeChat', 'Switch to native chat')}
    </Button>
  )
}
