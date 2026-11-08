import type { VoiceSettings } from './speech-types'

/** Choices the Voice pane offers: null never unloads, 0 unloads as soon as a dictation ends. */
export const UNLOAD_MODEL_AFTER_MINUTES_CHOICES = [null, 0, 5, 15, 60] as const

export type UnloadModelAfterMinutes = (typeof UNLOAD_MODEL_AFTER_MINUTES_CHOICES)[number]

export const DEFAULT_UNLOAD_MODEL_AFTER_MINUTES = 15

type VoiceUnloadSetting = Pick<VoiceSettings, 'unloadModelAfterMinutes'> | undefined

/** The saved choice; anything else (missing, or hand-edited past setTimeout's range) is the default. */
export function unloadModelAfterMinutes(voice: VoiceUnloadSetting): UnloadModelAfterMinutes {
  const saved = voice?.unloadModelAfterMinutes
  if (saved === null) {
    return null
  }
  return (
    UNLOAD_MODEL_AFTER_MINUTES_CHOICES.find((minutes) => minutes === saved) ??
    DEFAULT_UNLOAD_MODEL_AFTER_MINUTES
  )
}

/** How long an idle on-device model stays loaded, in ms; null keeps it loaded. */
export function voiceModelUnloadDelayMs(voice: VoiceUnloadSetting): number | null {
  const minutes = unloadModelAfterMinutes(voice)
  return minutes === null ? null : minutes * 60_000
}
