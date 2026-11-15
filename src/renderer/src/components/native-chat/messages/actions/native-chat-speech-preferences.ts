import {
  resolveNativeChatSpeechSettings,
  type ResolvedNativeChatSpeech
} from '../../../../../../shared/native-chat/native-chat-speech'

type SpeechPreferenceListener = () => void

let current: ResolvedNativeChatSpeech = resolveNativeChatSpeechSettings(undefined)
let published = false
const listeners = new Set<SpeechPreferenceListener>()

export function getNativeChatSpeechPreferences(): ResolvedNativeChatSpeech {
  return current
}

export function subscribeNativeChatSpeechPreferences(
  listener: SpeechPreferenceListener
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** True after the saved setting has been applied at least once. The module default is not that setting. */
export function nativeChatSpeechPreferencesPublished(): boolean {
  return published
}

/**
 * The Speak button is about to disappear while a reply may still be playing.
 * The first apply of a saved "off" is not a user turning speech off.
 */
export function nativeChatSpeechTurnsOff(
  currentSpeech: ResolvedNativeChatSpeech,
  value: unknown,
  preferencesPublished: boolean
): boolean {
  return (
    preferencesPublished && currentSpeech.enabled && !resolveNativeChatSpeechSettings(value).enabled
  )
}

function sameSpeech(next: ResolvedNativeChatSpeech): boolean {
  return (
    next.enabled === current.enabled &&
    next.engine === current.engine &&
    next.voice === current.voice &&
    next.rate === current.rate &&
    next.auto === current.auto
  )
}

/** Updates the snapshot rows will read. Does not re-render them yet. */
export function applyNativeChatSpeechPreferences(value: unknown): boolean {
  const next = resolveNativeChatSpeechSettings(value)
  published = true
  if (sameSpeech(next)) {
    return false
  }
  current = next
  return true
}

export function notifyNativeChatSpeechPreferences(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Rows re-render only when a resolved speech field changes. */
export function publishNativeChatSpeechPreferences(value: unknown): void {
  if (!applyNativeChatSpeechPreferences(value)) {
    return
  }
  notifyNativeChatSpeechPreferences()
}
