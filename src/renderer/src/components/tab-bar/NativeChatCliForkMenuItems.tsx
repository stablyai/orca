import { useState } from 'react'
import {
  useConversationSwitchReadiness,
  runNativeChatCliSwitch
} from '@/lib/conversation-surface-switch'
import { useShallow } from 'zustand/react/shallow'
import { ContextMenuSeparator } from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import { AiVaultSessionSurfaceSwitchMenuItems } from '../right-sidebar/AiVaultSessionSurfaceSwitchMenuItems'
import {
  resolveNativeChatCliForkIdentity,
  resolveTabSessionHistorySubject,
  type NativeChatTabSession
} from './tab-session-history-switch'
import { runNativeChatCliFork, useNativeChatCliForkPending } from './native-chat-cli-fork-run'
import { useInPlaceSwitchCapability } from '@/lib/in-place-switch-support'
import { useNativeChatExecutionHost } from '../native-chat/use-native-chat-execution-host'

type NativeChatCliMenuItemsProps = {
  tab: { id: string; worktreeId: string }
  nativeChat: NativeChatTabSession
  leadingSeparator: boolean
  onComplete?: () => void
}

/** Where the chat's host switches its agent in place the conversation moves (disabled until the
 *  host answers); where the host answered no, or the agent never switches, a copy opens in its CLI. */
export function NativeChatCliForkMenuItems(
  props: NativeChatCliMenuItemsProps
): React.JSX.Element | null {
  const { tab, nativeChat } = props
  const host = useNativeChatExecutionHost(
    tab.id,
    tab.worktreeId,
    nativeChat.sessionId,
    nativeChat.agent
  )
  return useInPlaceSwitchCapability(host, nativeChat.agent) === false ? (
    <NativeChatCliCopyMenuItems {...props} />
  ) : (
    <NativeChatCliSwitchMenuItems {...props} />
  )
}

/** Every supported chat switch uses the same owning-host command. */
function NativeChatCliSwitchMenuItems({
  tab,
  nativeChat,
  leadingSeparator,
  onComplete
}: NativeChatCliMenuItemsProps): React.JSX.Element | null {
  const chat = useAppStore(
    useShallow((state) => resolveNativeChatCliForkIdentity(state, { tab, nativeChat }))
  )
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === nativeChat.agent)
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
  if (!chat || !agent) {
    return null
  }
  return (
    <>
      {leadingSeparator ? <ContextMenuSeparator /> : null}
      <AiVaultSessionSurfaceSwitchMenuItems
        action="switch"
        menuKind="context"
        tooltipSide="right"
        cliPending={readiness.pending}
        switchLoading={!readiness.ready}
        switchExplanation={readiness.explanation}
        inPlaceAgent={agent}
        onResumeInNewCli={(event) => {
          event.preventDefault()
          void runNativeChatCliSwitch({
            sessionId: chat.sessionId,
            workspaceId: chat.workspaceId,
            executionHostId: chat.executionHostScope,
            agent,
            chatTabId: tab.id,
            onComplete
          })
        }}
      />
    </>
  )
}

function NativeChatCliCopyMenuItems({
  tab,
  nativeChat,
  leadingSeparator,
  onComplete
}: NativeChatCliMenuItemsProps): React.JSX.Element | null {
  const [subject] = useState(() =>
    resolveTabSessionHistorySubject(useAppStore.getState(), { tab, nativeChat })
  )
  const chat = subject?.kind === 'chat' ? subject : null
  const pending = useNativeChatCliForkPending(
    chat ? { executionHostScope: chat.request.executionHostScope, sessionId: chat.sessionId } : null
  )
  const commandOverrides = useAppStore((state) => state.settings?.agentCmdOverrides)
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === nativeChat.agent)
  if (!chat || !agent) {
    return null
  }
  return (
    <>
      {leadingSeparator ? <ContextMenuSeparator /> : null}
      <AiVaultSessionSurfaceSwitchMenuItems
        action="switch"
        menuKind="context"
        tooltipSide="right"
        cliPending={pending}
        onResumeInNewCli={(event) => {
          event.preventDefault()
          void runNativeChatCliFork({ subject: chat, tab, agent, commandOverrides, onComplete })
        }}
      />
    </>
  )
}
