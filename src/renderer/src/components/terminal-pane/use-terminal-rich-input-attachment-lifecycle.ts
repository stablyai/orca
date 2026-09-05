import { useCallback, useEffect, useRef, type RefObject } from 'react'

export type TerminalRichInputPendingPaste = { insertionPosition?: number }

export function useTerminalRichInputAttachmentLifecycle(
  focusEditor: () => void,
  queuedPastes: RefObject<TerminalRichInputPendingPaste[]>
): {
  mounted: RefObject<boolean>
  pendingTimer: RefObject<number | null>
  scheduleFocus: () => void
} {
  const mounted = useRef(false)
  const pendingTimer = useRef<number | null>(null)
  const focusAnimationFrames = useRef(new Set<number>())

  useEffect(() => {
    const timer = pendingTimer
    const frames = focusAnimationFrames.current
    const pendingPastes = queuedPastes
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
      for (const frame of frames) {
        cancelAnimationFrame(frame)
      }
      frames.clear()
      pendingPastes.current = []
    }
  }, [queuedPastes])

  const scheduleFocus = useCallback(() => {
    const frame = requestAnimationFrame(() => {
      focusAnimationFrames.current.delete(frame)
      if (mounted.current) {
        focusEditor()
      }
    })
    focusAnimationFrames.current.add(frame)
  }, [focusEditor])

  return { mounted, pendingTimer, scheduleFocus }
}
