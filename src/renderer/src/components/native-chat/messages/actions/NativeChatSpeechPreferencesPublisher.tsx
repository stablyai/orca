import { useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { resolveNativeChatSpeechSettings } from '../../../../../../shared/native-chat/native-chat-speech'
import { stopNativeChatSpeech } from './native-chat-speech-session'
import {
  applyNativeChatSpeechPreferences,
  getNativeChatSpeechPreferences,
  nativeChatSpeechPreferencesPublished,
  nativeChatSpeechTurnsOff,
  notifyNativeChatSpeechPreferences
} from './native-chat-speech-preferences'

/**
 * Keeps Speak on the saved speech settings without each reply row subscribing to the store.
 * The snapshot is applied while this component renders, before later siblings read it.
 */
export function NativeChatSpeechPreferencesPublisher(): null {
  const stored = useAppStore((state) => state.settings?.nativeChatSpeech)
  const stopOnCommit = useRef(false)
  if (
    nativeChatSpeechTurnsOff(
      getNativeChatSpeechPreferences(),
      stored,
      nativeChatSpeechPreferencesPublished()
    )
  ) {
    stopOnCommit.current = true
  } else if (resolveNativeChatSpeechSettings(stored).enabled) {
    stopOnCommit.current = false
  }
  const changed = applyNativeChatSpeechPreferences(stored)
  useLayoutEffect(() => {
    // Stop before rows hear the update. After it, the Speak button, the only stop control, is gone.
    if (stopOnCommit.current) {
      stopOnCommit.current = false
      stopNativeChatSpeech()
    }
    if (changed) {
      notifyNativeChatSpeechPreferences()
    }
  }, [changed, stored])
  return null
}
