import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import { useState } from 'react'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import { AiVaultSessionSurfaceSwitchMenuItems } from '../right-sidebar/AiVaultSessionSurfaceSwitchMenuItems'
import {
  resolveTabSessionHistorySubject,
  type NativeChatTabSession
} from './tab-session-history-switch'
import { runNativeChatCliFork, useNativeChatCliForkPending } from './native-chat-cli-fork-run'
import { useInPlaceSwitchCapability } from '@/lib/in-place-switch-support'
import { runNativeChatCliSwitch, useNativeChatCliSwitchPending } from './native-chat-cli-switch-run'

/** "Switch to CLI" where the chat's host switches its agent in place; otherwise the fork. */
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
  const forkPending = useNativeChatCliForkPending(
    chat ? { executionHostScope: chat.request.executionHostScope, sessionId: chat.sessionId } : null
  )
  const switchPending = useNativeChatCliSwitchPending(chat?.sessionId)
  const commandOverrides = useAppStore((state) => state.settings?.agentCmdOverrides)
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === nativeChat.agent)
  const inPlace = useInPlaceSwitchCapability(chat?.request.executionHostScope, agent)
  const enabled = useAppStore((state) => isNativeChatEnabled(state.settings))
  if (!chat || !agent || (!enabled && inPlace !== false)) {
    return null
  }
  return (
    <>
      {leadingSeparator ? <DropdownMenuSeparator /> : null}
      <AiVaultSessionSurfaceSwitchMenuItems
        action="switch"
        menuKind="dropdown"
        tooltipSide="right"
        cliPending={inPlace !== false ? switchPending : forkPending}
        switchLoading={inPlace === undefined}
        {...(inPlace !== false ? { inPlaceAgent: agent } : {})}
        onResumeInNewCli={(event) => {
          event.preventDefault()
          void (inPlace === true
            ? runNativeChatCliSwitch({
                sessionId: chat.sessionId,
                workspaceId: chat.workspaceId,
                executionHostId: chat.request.executionHostScope,
                agent,
                chatTabId: tab.id,
                onComplete
              })
            : runNativeChatCliFork({ subject: chat, tab, agent, commandOverrides, onComplete }))
        }}
      />
    </>
  )
}
