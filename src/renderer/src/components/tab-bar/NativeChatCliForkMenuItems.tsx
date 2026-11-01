import { useState } from 'react'
import { ContextMenuSeparator } from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import { AiVaultSessionSurfaceSwitchMenuItems } from '../right-sidebar/AiVaultSessionSurfaceSwitchMenuItems'
import {
  resolveTabSessionHistorySubject,
  type NativeChatTabSession
} from './tab-session-history-switch'
import { runNativeChatCliFork, useNativeChatCliForkPending } from './native-chat-cli-fork-run'

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
