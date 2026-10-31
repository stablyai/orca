import { useState } from 'react'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
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
import { inPlaceSwitchEnabled } from '../../../../shared/structured-agent-cli-conversation-adoption'

type NativeChatCliMenuItemsProps = {
  tab: { id: string; worktreeId: string }
  nativeChat: NativeChatTabSession
  leadingSeparator: boolean
  onComplete?: () => void
}

/** An agent that switches in place moves the conversation; any other agent opens a copy in its CLI. */
export function NativeChatCliForkMenuItems(
  props: NativeChatCliMenuItemsProps
): React.JSX.Element | null {
  return inPlaceSwitchEnabled(props.nativeChat.agent) ? (
    <NativeChatCliSwitchMenuItems {...props} />
  ) : (
    <NativeChatCliCopyMenuItems {...props} />
  )
}

/** Every supported chat switch uses the same consent and owning-host command. */
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
  if (!chat || !agent || !inPlaceSwitchEnabled(agent)) {
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
            confirm,
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
