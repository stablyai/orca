import { useEffect, useRef } from 'react'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../../shared/native-chat-question-auto-advance'

/** One cancellable delayed step: a single-select pick shows as chosen before the card moves on. */
export function useNativeChatQuestionAutoAdvance(): {
  schedule: (step: () => void) => void
  cancel: () => void
} {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const cancel = (): void => clearTimeout(timerRef.current)
  const schedule = (step: () => void): void => {
    cancel()
    timerRef.current = setTimeout(step, NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS)
  }
  useEffect(() => () => clearTimeout(timerRef.current), [])
  return { schedule, cancel }
}
