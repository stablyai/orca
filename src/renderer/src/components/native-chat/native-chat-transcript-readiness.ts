/** A retained transcript remains useful for recovering an interactive prompt after a read error. */
export function isNativeChatInteractiveTranscriptSettled(
  readPhase: 'loading' | 'ready' | 'error',
  messageCount: number
): boolean {
  return readPhase === 'ready' || (readPhase === 'error' && messageCount > 0)
}
