import { useLayoutEffect, useEffect, useRef, type RefObject } from 'react'
import { resolveClientEnvironmentInfo } from '@/lib/client-environment-info'
import {
  appendClientEnvironmentFooter,
  type ClientEnvironmentInfo
} from '../../../../shared/client-environment-info'

type FeedbackSelection = {
  feedback: string
  start: number
  end: number
  direction: 'forward' | 'backward' | 'none'
}

function insertClientEnvironmentFooter(params: {
  feedback: string
  environmentInfo: ClientEnvironmentInfo
}): string {
  const withFooter = appendClientEnvironmentFooter({
    message: params.feedback,
    info: params.environmentInfo
  })
  return params.feedback.trim() === '' ? `\n\n${withFooter}` : withFooter
}

/** Prefill version/OS footer without stealing caret while the user is typing. */
export function useSidebarFeedbackEnvironmentPrefill(params: {
  open: boolean
  feedback: string
  setFeedback: (updater: (current: string) => string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  mountedRef: RefObject<boolean>
}): void {
  const { open, feedback, setFeedback, textareaRef, mountedRef } = params
  const pendingFeedbackSelectionRef = useRef<FeedbackSelection | null>(null)

  useLayoutEffect(() => {
    const pending = pendingFeedbackSelectionRef.current
    if (!pending) {
      return
    }
    pendingFeedbackSelectionRef.current = null
    if (pending.feedback !== feedback) {
      return
    }
    const textarea = textareaRef.current
    if (textarea && document.activeElement === textarea) {
      textarea.setSelectionRange(pending.start, pending.end, pending.direction)
    }
  }, [feedback, textareaRef])

  // Why: copied feedback does not include the structured IPC metadata.
  useEffect(() => {
    if (!open) {
      return
    }

    let cancelled = false
    void resolveClientEnvironmentInfo().then((environmentInfo) => {
      if (cancelled || !mountedRef.current) {
        return
      }
      const textarea = textareaRef.current
      if (textarea && document.activeElement === textarea) {
        pendingFeedbackSelectionRef.current = {
          feedback: insertClientEnvironmentFooter({
            feedback: textarea.value,
            environmentInfo
          }),
          start: textarea.selectionStart,
          end: textarea.selectionEnd,
          direction: textarea.selectionDirection
        }
      }
      setFeedback((current) =>
        insertClientEnvironmentFooter({ feedback: current, environmentInfo })
      )
    })

    return () => {
      cancelled = true
    }
  }, [open, mountedRef, setFeedback, textareaRef])
}
