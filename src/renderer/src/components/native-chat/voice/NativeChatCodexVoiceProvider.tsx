import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import {
  NativeChatCodexVoiceContext,
  useNativeChatCodexVoice,
  useNativeChatCodexVoiceControl
} from './use-native-chat-codex-voice'
import { NativeChatCodexVoiceStrip } from './NativeChatCodexVoiceStrip'

/** Owns the chat's voice call for both the composer's button and the strip above it. */
export function NativeChatCodexVoiceProvider(props: {
  pane: { sessionId: string; target: RuntimeClientTarget; agent: string; isVisible: boolean }
  children: React.ReactNode
}): React.JSX.Element {
  const voice = useNativeChatCodexVoice({
    sessionId: props.pane.sessionId,
    target: props.pane.target,
    agent: props.pane.agent,
    visible: props.pane.isVisible
  })
  return <NativeChatCodexVoiceContext value={voice}>{props.children}</NativeChatCodexVoiceContext>
}

/** Stays mounted while an approval card replaces the composer, so the call survives it. */
export function NativeChatCodexVoiceStripSlot(props: {
  awaitingApproval: boolean
}): React.JSX.Element | null {
  const voice = useNativeChatCodexVoiceControl()
  if (!voice?.call) {
    return null
  }
  return (
    <NativeChatCodexVoiceStrip
      call={voice.call}
      awaitingApproval={props.awaitingApproval}
      onMute={voice.setMuted}
      onEnd={voice.stop}
      onDismiss={voice.dismiss}
    />
  )
}
