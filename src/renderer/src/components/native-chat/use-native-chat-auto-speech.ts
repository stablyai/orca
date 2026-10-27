import { useEffect, useRef, useSyncExternalStore } from 'react'
import { speakNativeChatMessage } from './native-chat-speech-session'
import {
  getNativeChatSpeechPreferences,
  subscribeNativeChatSpeechPreferences
} from './native-chat-speech-preferences'

const AUTO_SPEECH_DELAY_MS = 300

/**
 * Auto speaks the reply that just finished. It does not read replies already on screen.
 * A newer reply cancels the one still playing.
 */
export function useNativeChatAutoSpeech(input: {
  messageId: string
  markdown: string
  live: boolean
}): void {
  const settings = useSyncExternalStore(
    subscribeNativeChatSpeechPreferences,
    getNativeChatSpeechPreferences,
    getNativeChatSpeechPreferences
  )
  const liveRef = useRef(input.live)
  const markdownRef = useRef(input.markdown)
  markdownRef.current = input.markdown

  useEffect(() => {
    const wasLive = liveRef.current
    liveRef.current = input.live
    if (!wasLive || input.live || !settings.enabled || !settings.auto) {
      return
    }
    const messageId = input.messageId
    let spoke = false
    const timer = window.setTimeout(() => {
      spoke = true
      void speakNativeChatMessage({
        messageId,
        markdown: markdownRef.current,
        settings
      })
    }, AUTO_SPEECH_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
      // A discarded setup (React remounts the effect once) must see the same transition again.
      if (!spoke) {
        liveRef.current = wasLive
      }
    }
  }, [input.live, input.messageId, settings])
}
