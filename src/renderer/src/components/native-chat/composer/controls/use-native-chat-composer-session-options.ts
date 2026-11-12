import { useNativeChatSessionOptionCommand } from '../../session/options/terminal/use-native-chat-session-option-command'
import { useNativeChatSessionOptions } from '../../session/options/terminal/use-native-chat-session-options'
import type { NativeChatComposerProps } from '../native-chat-composer-types'
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
  | 'transcriptMessages'
  | 'structuredTransport'
> &
  Pick<Parameters<typeof useNativeChatSessionOptionCommand>[0], 'disabled' | 'resolveTarget'>

export function useNativeChatComposerSessionOptions({
  agent,
  disabled,
  onSlashCommand,
  onSubmitted,
  resolveTarget,
  terminalTabId,
  targetPtyId,
  onSwitchToTerminal,
  readTerminalScreen,
  transcriptMessages,
  paneKey,
  structuredTransport
}: ComposerSessionOptionsArgs): {
  isDispatching: boolean
  pty: ReturnType<typeof useNativeChatSessionOptions>
  surface: SessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
} {
  const { dispatch, isDispatching } = useNativeChatSessionOptionCommand({
    agent,
    disabled,
    onSlashCommand,
    onSubmitted,
    resolveTarget
  })
  const pty = useNativeChatSessionOptions({
    agent,
    terminalTabId,
    targetPtyId,
    dispatchCommand: dispatch,
    onAgentPicker: onSwitchToTerminal,
    readTerminalScreen,
    transcriptMessages,
    paneKey
  })
  return {
    isDispatching,
    pty,
    surface: structuredTransport?.optionsSurface ?? pty.surface,
    snapshot: structuredTransport?.optionSnapshot ?? pty.snapshot
  }
}
