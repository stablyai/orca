import { useState } from 'react'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { ContextMenuSeparator } from '@/components/ui/context-menu'
import { useAppStore } from '@/store/index'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { AI_VAULT_AGENTS } from '../../../../../shared/ai-vault/contracts/ai-vault-types'
import { AiVaultSessionSurfaceSwitchMenuItems } from '../../right-sidebar/ai-vault/session-list/AiVaultSessionSurfaceSwitchMenuItems'
import {
  resolveTabSessionHistorySubject,
  type NativeChatTabSession
} from './tab-session-history-switch'
import { runNativeChatCliFork, useNativeChatCliForkPending } from './native-chat-cli-fork-run'

export function NativeChatCliForkMenuItems({
  tab,
  nativeChat,
  leadingSeparator,
  menuKind = 'context',
  onComplete,
  beforeRun,
  requireLocalHost = false
}: {
  tab: { id: string; worktreeId: string }
  nativeChat: NativeChatTabSession
  leadingSeparator: boolean
  menuKind?: 'context' | 'dropdown'
  onComplete?: () => void
  beforeRun?: () => boolean
  /** Offer the fork only when it prepares and launches on this computer. */
  requireLocalHost?: boolean
}): React.JSX.Element | null {
  const [subject] = useState(() =>
    resolveTabSessionHistorySubject(useAppStore.getState(), { tab, nativeChat })
  )
  const chat = subject?.kind === 'chat' ? subject : null
  const pending = useNativeChatCliForkPending(
    chat ? { executionHostScope: chat.request.executionHostScope, sessionId: chat.sessionId } : null
  )
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === nativeChat.agent)
  if (
    !chat ||
    !agent ||
    (requireLocalHost && chat.request.executionHostScope !== LOCAL_EXECUTION_HOST_ID)
  ) {
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
          if (beforeRun && !beforeRun()) {
            return
          }
          void runNativeChatCliFork({ subject: chat, tab, agent, onComplete })
        }}
      />
    </>
  )
}
