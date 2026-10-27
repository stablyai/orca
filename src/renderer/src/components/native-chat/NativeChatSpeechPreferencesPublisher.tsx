import { useEffect } from 'react'
import { useAppStore } from '../../store'
import { publishNativeChatSpeechPreferences } from './native-chat-speech-preferences'

/** Keeps the Speak button on the saved speech settings without each row subscribing to the store. */
export function NativeChatSpeechPreferencesPublisher(): null {
  const stored = useAppStore((state) => state.settings?.nativeChatSpeech)
  useEffect(() => {
    publishNativeChatSpeechPreferences(stored)
  }, [stored])
  return null
}
