import { useNativeChatViewLease } from './native-chat-view-parking-owner'
import { useEffect, useRef } from 'react'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../../shared/native-chat-question-auto-advance'

/** One cancellable delayed step: a single-select pick shows as chosen before the card moves on. */
export function useNativeChatQuestionAutoAdvance(): {
  schedule: (step: () => void) => void
  cancel: () => void
} {
  const acquireLease = useNativeChatViewLease()
  const releaseRef = useRef<(() => void) | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const cancel = (): void => {
    clearTimeout(timerRef.current)
    releaseRef.current?.()
    releaseRef.current = null
  }
  const schedule = (step: () => void): void => {
    cancel()
    releaseRef.current = acquireLease()
    timerRef.current = setTimeout(() => {
      try {
        step()
      } finally {
        cancel()
      }
    }, NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS)
  }
  useEffect(() => cancel, [])
  return { schedule, cancel }
}
