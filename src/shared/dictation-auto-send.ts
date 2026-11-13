import type { VoiceSettings } from './speech-types'

/** Delays the Voice pane offers before a dictated chat message sends on its own. */
export const DICTATION_AUTO_SEND_DELAYS_MS = [1000, 2000, 3000, 5000] as const

export const DEFAULT_DICTATION_AUTO_SEND_DELAY_MS = 2000

/** The saved delay; anything off the list (missing, or from an older host) is the default. */
export function dictationAutoSendDelayMs(
  voice: Pick<VoiceSettings, 'autoSendDelayMs'> | undefined
): number {
  return (
    DICTATION_AUTO_SEND_DELAYS_MS.find((delayMs) => delayMs === voice?.autoSendDelayMs) ??
    DEFAULT_DICTATION_AUTO_SEND_DELAY_MS
  )
}
