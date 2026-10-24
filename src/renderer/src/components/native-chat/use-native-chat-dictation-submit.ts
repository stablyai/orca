import { useEffect, useEffectEvent, type RefObject } from 'react'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { DICTATION_SUBMIT_EVENT } from '../dictation/dictation-auto-send'

/** Sends, as Enter would, when a dictation countdown into this composer's input ends. */
export function useNativeChatDictationSubmit(
  inputRef: RefObject<NativeChatComposerInput | null>,
  send: () => void
): void {
  const sendLatest = useEffectEvent(send)

  useEffect(() => {
    const handleSubmit = (event: Event): void => {
      if (!(event instanceof CustomEvent)) {
        return
      }
      const element: unknown = event.detail?.element
      if (element instanceof Node && inputRef.current?.contains?.(element)) {
        sendLatest()
      }
    }
    document.addEventListener(DICTATION_SUBMIT_EVENT, handleSubmit)
    return () => document.removeEventListener(DICTATION_SUBMIT_EVENT, handleSubmit)
  }, [inputRef])
}
