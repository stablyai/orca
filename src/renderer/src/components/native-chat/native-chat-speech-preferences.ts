import {
  resolveNativeChatSpeechSettings,
  type ResolvedNativeChatSpeech
} from '../../../../shared/native-chat-speech'

type SpeechPreferenceListener = () => void

let current: ResolvedNativeChatSpeech = resolveNativeChatSpeechSettings(undefined)
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

/** Rows re-render only when a resolved speech field changes. */
export function publishNativeChatSpeechPreferences(value: unknown): void {
  const next = resolveNativeChatSpeechSettings(value)
  if (
    next.enabled === current.enabled &&
    next.engine === current.engine &&
    next.voice === current.voice &&
    next.rate === current.rate &&
    next.auto === current.auto
  ) {
    return
  }
  current = next
  for (const listener of listeners) {
    listener()
  }
}
