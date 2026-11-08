const DICTATION_SILENCE_STOP_MS = 60_000

/**
 * Calls onSilence once a minute passes with no speech; returns a cancel.
 * Timing runs on now(), not on audio, so a stalled stream still counts as silence.
 */
export function watchDictationSilence(
  lastSpeechAt: () => number,
  now: () => number,
  onSilence: () => void
): () => void {
  const startedAt = now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = (): void => {
    const remainingMs = Math.max(startedAt, lastSpeechAt()) + DICTATION_SILENCE_STOP_MS - now()
    if (remainingMs > 0) {
      timer = setTimeout(check, remainingMs)
    } else {
      onSilence()
    }
  }
  check()
  return () => clearTimeout(timer)
}
