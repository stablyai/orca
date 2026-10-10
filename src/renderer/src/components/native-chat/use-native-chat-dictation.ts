import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useCallback, useState, type RefObject } from 'react'
import { useAppStore } from '../../store'
import { dispatchDictationControl } from '../dictation/dictation-control-events'

/** Whether the composer can dictate and is dictating now, and the controls that start and stop it. */
export function useNativeChatDictation(textareaRef: RefObject<NativeChatComposerInput | null>): {
  dictationDisabled: boolean
  isDictating: boolean
  isDictationHoldMode: boolean
  toggleDictation: () => void
  startHoldDictation: () => void
  stopHoldDictation: () => void
} {
  const [dictationPressed, setDictationPressed] = useState(false)
  const dictationState = useAppStore((store) => store.dictationState)
  const voiceSettings = useAppStore((store) => store.settings?.voice)
  const focusForDictation = useCallback(() => textareaRef.current?.focus(), [textareaRef])
  const toggleDictation = useCallback(() => {
    focusForDictation()
    dispatchDictationControl('toggle')
  }, [focusForDictation])
  const startHoldDictation = useCallback(() => {
    setDictationPressed(true)
    focusForDictation()
    dispatchDictationControl('start')
  }, [focusForDictation])
  const stopHoldDictation = useCallback(() => {
    setDictationPressed(false)
    dispatchDictationControl('stop')
  }, [])
  return {
    dictationDisabled: voiceSettings?.enabled !== true || !voiceSettings.sttModel,
    isDictating:
      dictationPressed ||
      dictationState === 'starting' ||
      dictationState === 'listening' ||
      dictationState === 'stopping',
    isDictationHoldMode: voiceSettings?.dictationMode === 'hold',
    toggleDictation,
    startHoldDictation,
    stopHoldDictation
  }
}
