import type { NativeChatMessage } from './native-chat-types'

export const EMPTY_NATIVE_CHAT_TRANSCRIPT: NativeChatMessage[] = []

export function encodeNativeChatTranscriptIdentity(parts: readonly (string | null)[]): string {
  return JSON.stringify(parts)
}

export type NativeChatTranscriptRetention = {
  capture: (identity: string, messages: NativeChatMessage[]) => void
  visible: (args: {
    identity: string
    messages: NativeChatMessage[]
    settled: boolean
    loading: boolean
  }) => NativeChatMessage[]
}

/** Retains one settled transcript so a same-source rebind does not blank the conversation. */
export function createNativeChatTranscriptRetention(): NativeChatTranscriptRetention {
  let captured: { identity: string; messages: NativeChatMessage[] } | null = null

  return {
    capture(identity, messages) {
      captured = { identity, messages }
    },
    visible({ identity, messages, settled, loading }) {
      if (settled) {
        return messages
      }
      return loading && captured?.identity === identity
        ? captured.messages
        : EMPTY_NATIVE_CHAT_TRANSCRIPT
    }
  }
}
