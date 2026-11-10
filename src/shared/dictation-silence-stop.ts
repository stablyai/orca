import type { VoiceSettings } from './speech-types'

/** Choices the Voice pane offers, in seconds; null never stops for silence. */
export const STOP_AFTER_SILENCE_SECONDS_CHOICES = [null, 30, 60, 120] as const

export type StopAfterSilenceSeconds = (typeof STOP_AFTER_SILENCE_SECONDS_CHOICES)[number]

export const DEFAULT_STOP_AFTER_SILENCE_SECONDS = 60

/** The saved choice; anything else (missing, or from a phone's salvaged host reply) is the default. */
export function stopAfterSilenceSeconds(
  voice: Pick<VoiceSettings, 'stopAfterSilenceSeconds'> | undefined
): StopAfterSilenceSeconds {
  const saved = voice?.stopAfterSilenceSeconds
  if (saved === null) {
    return null
  }
  return (
    STOP_AFTER_SILENCE_SECONDS_CHOICES.find((seconds) => seconds === saved) ??
    DEFAULT_STOP_AFTER_SILENCE_SECONDS
  )
}

/**
 * Calls onSilence once `silenceMs` passes with no speech; returns a cancel.
 * Timing runs on now(), not on audio, so a stalled stream still counts as silence.
 */
export function watchDictationSilence(
  lastSpeechAt: () => number,
  now: () => number,
  silenceMs: number,
  onSilence: () => void
): () => void {
  const startedAt = now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = (): void => {
    const remainingMs = Math.max(startedAt, lastSpeechAt()) + silenceMs - now()
    if (remainingMs > 0) {
      timer = setTimeout(check, remainingMs)
    } else {
      onSilence()
    }
  }
  check()
  return () => clearTimeout(timer)
}
