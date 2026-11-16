import { useNativeChatPaneLifetimeEffect } from '../pane/ownership/native-chat-pane-lifetime'
import { useCallback, useRef } from 'react'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../../../shared/native-chat/input/questions/native-chat-question-auto-advance'

/** One cancellable delayed step: a single-select pick shows as chosen before the card moves on. */
export function useNativeChatQuestionAutoAdvance(disabled = false): {
  schedule: (step: () => void) => void
  cancel: () => void
} {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const cancel = (): void => clearTimeout(timerRef.current)
  const schedule = (step: () => void): void => {
    cancel()
    timerRef.current = setTimeout(step, NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS)
  }
  useNativeChatPaneLifetimeEffect(
    useCallback(() => {
      if (disabled) {
        clearTimeout(timerRef.current)
      }
      return () => clearTimeout(timerRef.current)
    }, [disabled])
  )
  return { schedule, cancel }
}
