import { useNativeChatSessionOptionCommand } from '../../session/options/terminal/use-native-chat-session-option-command'
import { useNativeChatSessionOptions } from '../../session/options/terminal/use-native-chat-session-options'
import { useNativeChatContextUsageSummary } from '../../usage/use-native-chat-context-usage-summary'
import type { NativeChatComposerProps } from '../native-chat-composer-types'
import type { NativeChatSendHandle } from '../../session/terminal/send/native-chat-runtime-send'
import type { NativeChatPtySessionOptionsSurface } from '../../../../../../shared/native-chat/input/session-options/native-chat-pty-session-options'
import { nativeChatCommandOpensTerminal } from '../../../../../../shared/native-chat/input/commands/native-chat-agent-profiles'
import { useCallback } from 'react'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../../shared/native-chat/input/native-chat-session-options'

type ComposerSessionOptionsArgs = Pick<
  NativeChatComposerProps,
  | 'agent'
  | 'terminalTabId'
  | 'targetPtyId'
  | 'paneKey'
  | 'onSlashCommand'
  | 'onSubmitted'
  | 'onSwitchToTerminal'
  | 'readTerminalScreen'
  | 'structuredTransport'
  | 'contextMessages'
> &
  Pick<
    Parameters<typeof useNativeChatSessionOptionCommand>[0],
    'disabled' | 'resolveTarget' | 'readTerminalDraft'
  >

export function useNativeChatComposerSessionOptions({
  agent,
  disabled,
  onSlashCommand,
  onSubmitted,
  readTerminalDraft,
  resolveTarget,
  terminalTabId,
  targetPtyId,
  onSwitchToTerminal,
  readTerminalScreen,
  paneKey,
  structuredTransport,
  contextMessages
}: ComposerSessionOptionsArgs): {
  /** What a PTY command send needs from the session options. */
  ptyCommandRouting: {
    isDispatchingSessionOption: boolean
    sessionOptionsSurface: NativeChatPtySessionOptionsSurface | null
    /** Switches to Terminal once a command that opens a TUI screen is in. */
    onCommandSent: (command: string, delivery: NativeChatSendHandle) => void
  }
  surface: SessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
  contextUsage: ReturnType<typeof useNativeChatContextUsageSummary>
} {
  const { dispatch, isDispatching } = useNativeChatSessionOptionCommand({
    agent,
    disabled,
    onSlashCommand,
    onSubmitted,
    readTerminalDraft,
    resolveTarget
  })
  const pty = useNativeChatSessionOptions({
    agent,
    terminalTabId,
    targetPtyId,
    dispatchCommand: dispatch,
    onAgentPicker: onSwitchToTerminal,
    readTerminalScreen,
    paneKey
  })
  const contextUsage = useNativeChatContextUsageSummary(structuredTransport, {
    agent,
    messages: contextMessages,
    surface: pty.surface
  })
  const onCommandSent = useCallback(
    (command: string, delivery: NativeChatSendHandle) => {
      if (!onSwitchToTerminal || !nativeChatCommandOpensTerminal(agent, command)) {
        return
      }
      // Why: leaving the chat cancels its pending writes, so switch only once the command is in.
      void delivery.outcome?.then((outcome) => {
        if (outcome === 'submitted') {
          onSwitchToTerminal()
        }
      })
    },
    [agent, onSwitchToTerminal]
  )
  return {
    contextUsage,
    ptyCommandRouting: {
      isDispatchingSessionOption: isDispatching,
      sessionOptionsSurface: pty.surface,
      onCommandSent
    },
    surface: structuredTransport?.optionsSurface ?? pty.surface,
    snapshot: structuredTransport?.optionSnapshot ?? pty.snapshot
  }
}
