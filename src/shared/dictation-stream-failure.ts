// Why: a stable prefix lets new phones finish (keep committed text) instead of discarding; old phones still cancel.
export const DICTATION_STREAM_FAILED_PREFIX = 'dictation_stream_failed: '

export function formatDictationStreamFailure(message: string): string {
  return `${DICTATION_STREAM_FAILED_PREFIX}${message}`
}

/** The provider's message when `message` reports a failed stream, else null. */
export function parseDictationStreamFailure(message: string): string | null {
  return message.startsWith(DICTATION_STREAM_FAILED_PREFIX)
    ? message.slice(DICTATION_STREAM_FAILED_PREFIX.length).trim() || 'Dictation stream failed.'
    : null
}
