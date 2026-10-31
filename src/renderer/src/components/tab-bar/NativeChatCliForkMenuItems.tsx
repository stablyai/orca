import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import {
  useConversationSwitchReadiness,
  runNativeChatCliSwitch
} from '@/lib/conversation-surface-switch'
import { useShallow } from 'zustand/react/shallow'
import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import { ContextMenuSeparator } from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import { AiVaultSessionSurfaceSwitchMenuItems } from '../right-sidebar/AiVaultSessionSurfaceSwitchMenuItems'
import {
  resolveNativeChatCliForkIdentity,
  type NativeChatTabSession
} from './tab-session-history-switch'
import { inPlaceSwitchEnabled } from '../../../../shared/structured-agent-cli-conversation-adoption'

/** Every supported chat switch uses the same consent and owning-host command. */
export function NativeChatCliForkMenuItems({
  tab,
  nativeChat,
  leadingSeparator,
  onComplete
}: {
  tab: { id: string; worktreeId: string }
  nativeChat: NativeChatTabSession
  leadingSeparator: boolean
  onComplete?: () => void
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
  const enabled = useAppStore((state) => isNativeChatEnabled(state.settings))
  if (!chat || !agent || !enabled || !inPlaceSwitchEnabled(agent)) {
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
