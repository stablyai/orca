import { useCallback, useEffect, useRef, useState } from 'react'

export type ClipboardTextCopyStatus = 'idle' | 'copied' | 'failed'

const FEEDBACK_MS = 1500

type Feedback = {
  text: string
  status: Exclude<ClipboardTextCopyStatus, 'idle'>
}

/** Show brief clipboard feedback, skipping late state writes after the menu/row unmounts. */
export function useClipboardTextCopyFeedback(text: string): {
  canCopy: boolean
  copyText: () => Promise<boolean>
  status: ClipboardTextCopyStatus
} {
  // Key feedback to content so prop changes clear stale labels without derived-state effects.
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const isMountedRef = useRef(true)
  const resetTimerRef = useRef<number | null>(null)
  const canCopy = text.trim().length > 0
  const status: ClipboardTextCopyStatus =
    feedback != null && feedback.text === text ? feedback.status : 'idle'

  const clearResetTimer = useCallback((): void => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      clearResetTimer()
    }
  }, [clearResetTimer])

  // Drop any pending reset timer when the body changes; display status is already idle.
  useEffect(() => {
    clearResetTimer()
  }, [clearResetTimer, text])

  const scheduleReset = useCallback((): void => {
    clearResetTimer()
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null
      if (isMountedRef.current) {
        setFeedback(null)
      }
    }, FEEDBACK_MS)
  }, [clearResetTimer])

  const copyText = useCallback(async (): Promise<boolean> => {
    if (!canCopy) {
      return false
    }
    try {
      await window.api.ui.writeClipboardText(text)
      if (!isMountedRef.current) {
        return true
      }
      setFeedback({ text, status: 'copied' })
      scheduleReset()
      return true
    } catch {
      if (!isMountedRef.current) {
        return false
      }
      setFeedback({ text, status: 'failed' })
      scheduleReset()
      return false
    }
  }, [canCopy, scheduleReset, text])

  return { canCopy, copyText, status }
}
