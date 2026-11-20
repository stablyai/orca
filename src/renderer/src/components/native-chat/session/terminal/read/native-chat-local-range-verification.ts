import type { NativeChatSessionTransport } from './native-chat-session-transport'

let nextRequest = 0

export const verifyLocalTranscriptRanges: NativeChatSessionTransport['verifyTranscriptRanges'] =
  async (agent, sessionId, ranges, transcriptPath, signal) => {
    signal?.throwIfAborted()
    const api = window.api.nativeChat
    if (!api.verifyTranscriptRanges) {
      return null
    }
    const requestId = `verify-${++nextRequest}`
    const abort = (): void => {
      api.cancelTranscriptRangeVerification?.(requestId)
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await api.verifyTranscriptRanges(agent, sessionId, ranges, transcriptPath, requestId)
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }
