import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useCallback, useState, type RefObject } from 'react'
import { useAppStore } from '../../store'
import { dispatchDictationControl } from '../dictation/dictation-control-events'

/** Whether the composer can dictate and is dictating now, and the controls that start and stop it. */
export function useNativeChatDictation(
  textareaRef: RefObject<NativeChatComposerInput | null>,
  disabled: boolean
): {
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
  const isDictating =
    dictationPressed ||
    dictationState === 'starting' ||
    dictationState === 'listening' ||
    dictationState === 'stopping'
  const dictationDisabled =
    !isDictating && (disabled || voiceSettings?.enabled !== true || !voiceSettings.sttModel)
  const focusForDictation = useCallback(() => textareaRef.current?.focus(), [textareaRef])
  const toggleDictation = useCallback(() => {
    if (isDictating) {
      dispatchDictationControl('stop')
    } else if (!dictationDisabled) {
      focusForDictation()
      dispatchDictationControl('toggle')
    }
  }, [dictationDisabled, focusForDictation, isDictating])
  const startHoldDictation = useCallback(() => {
    if (disabled || dictationDisabled || isDictating) {
      return
    }
    setDictationPressed(true)
    focusForDictation()
    dispatchDictationControl('start')
  }, [disabled, dictationDisabled, focusForDictation, isDictating])
  const stopHoldDictation = useCallback(() => {
    setDictationPressed(false)
    dispatchDictationControl('stop')
  }, [])
  return {
    dictationDisabled,
    isDictating,
    isDictationHoldMode: voiceSettings?.dictationMode === 'hold',
    toggleDictation,
    startHoldDictation,
    stopHoldDictation
  }
}
