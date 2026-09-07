import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { dispatchDictationControl } from '../dictation/dictation-control-events'

export function useNativeChatDictationActions(args: {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  setDictationPressed: Dispatch<SetStateAction<boolean>>
}): {
  toggleDictation: () => void
  startHoldDictation: () => void
  stopHoldDictation: () => void
} {
  const { setDictationPressed, textareaRef } = args
  const focusForDictation = useCallback(() => textareaRef.current?.focus(), [textareaRef])
  const toggleDictation = useCallback(() => {
    focusForDictation()
    dispatchDictationControl('toggle')
  }, [focusForDictation])
  const startHoldDictation = useCallback(() => {
    setDictationPressed(true)
    focusForDictation()
    dispatchDictationControl('start')
  }, [focusForDictation, setDictationPressed])
  const stopHoldDictation = useCallback(() => {
    setDictationPressed(false)
    dispatchDictationControl('stop')
  }, [setDictationPressed])
  return { toggleDictation, startHoldDictation, stopHoldDictation }
}
