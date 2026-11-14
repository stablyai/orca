import { useState } from 'react'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { ContextMenuSeparator } from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { AiVaultSessionSurfaceSwitchMenuItems } from '../right-sidebar/ai-vault/session-list/AiVaultSessionSurfaceSwitchMenuItems'
import {
  resolveTabSessionHistorySubject,
  type NativeChatTabSession
} from './tab-session-history-switch'
import { runNativeChatCliFork, useNativeChatCliForkPending } from './native-chat-cli-fork-run'
import { NativeChatWorktreeForkMenuItem } from '../native-chat/messages/actions/NativeChatWorktreeForkMenuItem'

export function NativeChatCliForkMenuItems({
  tab,
  nativeChat,
  leadingSeparator,
  menuKind = 'context',
  onComplete
}: {
  tab: { id: string; worktreeId: string }
  nativeChat: NativeChatTabSession
  leadingSeparator: boolean
  menuKind?: 'context' | 'dropdown'
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
  const Separator = menuKind === 'context' ? ContextMenuSeparator : DropdownMenuSeparator
  return (
    <>
      {leadingSeparator ? <Separator /> : null}
      <AiVaultSessionSurfaceSwitchMenuItems
        action="switch"
        menuKind={menuKind}
        tooltipSide="right"
        cliPending={pending}
        onResumeInNewCli={(event) => {
          event.preventDefault()
          void runNativeChatCliFork({ subject: chat, tab, agent, commandOverrides, onComplete })
        }}
      />
      <NativeChatWorktreeForkMenuItem tab={tab} menuKind={menuKind} onComplete={onComplete} />
    </>
  )
}
