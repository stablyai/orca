import { useEffect, useRef, useSyncExternalStore } from 'react'
import { speakNativeChatMessage } from './native-chat-speech-session'
import {
  getNativeChatSpeechPreferences,
  subscribeNativeChatSpeechPreferences
} from './native-chat-speech-preferences'

const AUTO_SPEECH_DELAY_MS = 300

/**
 * Reads the turn's result once, when that turn stops.
 * A reply already on screen is not read. A newer result cancels the one still playing.
 * Losing the result slot while the turn is still working stays silent: that text was not the result.
 */
export function useNativeChatAutoSpeech(input: {
  messageId: string
  markdown: string
  /** This row is the turn's last reply, the one that holds the result controls. */
  answer: boolean
  /** The turn is still producing. */
  working: boolean
}): void {
  const settings = useSyncExternalStore(
    subscribeNativeChatSpeechPreferences,
    getNativeChatSpeechPreferences,
    getNativeChatSpeechPreferences
  )
  const workingRef = useRef(input.working)
  const markdownRef = useRef(input.markdown)
  markdownRef.current = input.markdown

  useEffect(() => {
    const wasWorking = workingRef.current
    workingRef.current = input.working
    if (!input.answer || !wasWorking || input.working || !settings.enabled || !settings.auto) {
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
        workingRef.current = wasWorking
      }
    }
  }, [input.answer, input.working, input.messageId, settings])
}
