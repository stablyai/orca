import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { publishNativeChatSpeechPreferences } from './native-chat-speech-preferences'

/** Keeps Speak on the saved speech settings without each reply row subscribing to the store. */
export function NativeChatSpeechPreferencesPublisher(): null {
  const stored = useAppStore((state) => state.settings?.nativeChatSpeech)
  useEffect(() => {
    publishNativeChatSpeechPreferences(stored)
  }, [stored])
  return null
}
