import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { MessagesSquare, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useInPlaceSwitchCapability } from '@/lib/in-place-switch-support'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import { resolveCliChatResumeSource, useCliChatResumeCapability } from './cli-chat-resume-source'
import { runCliChatResume, useCliChatResumePending } from './cli-chat-resume-run'
import { runNativeChatCliSwitch, useNativeChatCliSwitchPending } from './native-chat-cli-switch-run'
import {
  resolveTabSessionHistorySubject,
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
  const enabled = useAppStore((state) => isNativeChatEnabled(state.settings))
  if (!enabled) {
    return null
  }
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
  const [subject] = useState(() =>
    resolveTabSessionHistorySubject(useAppStore.getState(), { tab, nativeChat })
  )
  const chat = subject?.kind === 'chat' ? subject : null
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === nativeChat.agent)
  const inPlace = useInPlaceSwitchCapability(chat?.request.executionHostScope, agent)
  const pending = useNativeChatCliSwitchPending(chat?.sessionId)
  if (!chat || !agent || inPlace === false) {
    return null
  }
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={pending || inPlace === undefined}
      onClick={() =>
        void runNativeChatCliSwitch({
          sessionId: chat.sessionId,
          workspaceId: chat.workspaceId,
          executionHostId: chat.request.executionHostScope,
          agent,
          chatTabId: tab.id
        })
      }
    >
      <SquareTerminal />
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
  const capability = useCliChatResumeCapability(tab.worktreeId, source?.agent)
  const pending = useCliChatResumePending(source)
  if (!source || capability === false) {
    return null
  }
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={pending || capability === undefined}
      onClick={() => void runCliChatResume(source)}
    >
      <MessagesSquare />
      {translate('components.tab.bar.switch.toNativeChat', 'Switch to native chat')}
    </Button>
  )
}
