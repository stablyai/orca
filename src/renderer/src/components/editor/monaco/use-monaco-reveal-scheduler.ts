import { useCallback, useRef } from 'react'
import type { editor } from 'monaco-editor'
import { MAX_REVEAL_CONTENT_WAIT_FRAMES, performReveal } from './monaco-reveal'

export type MonacoRevealScheduler = {
  clearTransientRevealHighlight: () => void
  cancelScheduledReveal: () => void
  queueReveal: (
    editorInstance: editor.IStandaloneCodeEditor,
    line: number,
    column: number,
    matchLength: number,
    onApplied?: () => void,
    canApply?: () => boolean
  ) => void
}

// Own both reveal frames and content-wait timers together so cancellation cannot leave a partial reveal.
export function useMonacoRevealScheduler(): MonacoRevealScheduler {
  const revealDecorationRef = useRef<editor.IEditorDecorationsCollection | null>(null)
  const revealHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const revealRafRef = useRef<number | null>(null)
  const revealInnerRafRef = useRef<number | null>(null)

  const clearTransientRevealHighlight = useCallback(() => {
    if (revealHighlightTimerRef.current !== null) {
      clearTimeout(revealHighlightTimerRef.current)
      revealHighlightTimerRef.current = null
    }
    revealDecorationRef.current?.clear()
    revealDecorationRef.current = null
  }, [])

  const cancelScheduledReveal = useCallback(() => {
    if (revealRafRef.current !== null) {
      cancelAnimationFrame(revealRafRef.current)
      revealRafRef.current = null
    }
    if (revealInnerRafRef.current !== null) {
      cancelAnimationFrame(revealInnerRafRef.current)
      revealInnerRafRef.current = null
    }
  }, [])

  const queueReveal = useCallback(
    (
      editorInstance: editor.IStandaloneCodeEditor,
      line: number,
      column: number,
      matchLength: number,
      onApplied?: () => void,
      canApply?: () => boolean
    ) => {
      cancelScheduledReveal()
      let waitFrames = 0

      const schedule = (): void => {
        // Wait two frames for Monaco viewport geometry to settle before scrolling/highlighting.
        revealRafRef.current = requestAnimationFrame(() => {
          revealInnerRafRef.current = requestAnimationFrame(() => {
            revealRafRef.current = null
            revealInnerRafRef.current = null
            if (canApply?.() === false) {
              return
            }
            const modelLineCount = editorInstance.getModel()?.getLineCount() ?? 0
            if (line > 1 && modelLineCount < line && waitFrames < MAX_REVEAL_CONTENT_WAIT_FRAMES) {
              // Async opens can mount an empty model; wait before the target line is clamped to 1.
              waitFrames += 2
              schedule()
              return
            }

            performReveal(
              editorInstance,
              line,
              column,
              matchLength,
              clearTransientRevealHighlight,
              revealDecorationRef,
              revealHighlightTimerRef
            )
            onApplied?.()
          })
        })
      }

      schedule()
    },
    [cancelScheduledReveal, clearTransientRevealHighlight]
  )

  return { clearTransientRevealHighlight, cancelScheduledReveal, queueReveal }
}
