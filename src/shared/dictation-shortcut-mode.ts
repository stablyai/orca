import type { VoiceSettings } from './speech-types'

/** The shortcut's behaviour; Auto is Toggle plus hold-to-record, so builds that only know Toggle still toggle. */
export type DictationShortcutMode = 'auto' | 'hold' | 'toggle'

// Loose so a phone's salvaged host reply reads the same way as stored settings.
type StoredDictationMode = { dictationMode?: string; dictationHoldToRecord?: boolean }

export function dictationShortcutMode(
  voice: StoredDictationMode | null | undefined
): DictationShortcutMode {
  if (voice?.dictationMode === 'hold') {
    return 'hold'
  }
  return voice?.dictationHoldToRecord === false ? 'toggle' : 'auto'
}

export function dictationShortcutModeSettings(
  mode: DictationShortcutMode
): Pick<VoiceSettings, 'dictationMode' | 'dictationHoldToRecord'> {
  return mode === 'hold'
    ? { dictationMode: 'hold', dictationHoldToRecord: false }
    : { dictationMode: 'toggle', dictationHoldToRecord: mode === 'auto' }
}
