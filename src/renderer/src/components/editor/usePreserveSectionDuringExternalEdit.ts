import { useEffect, useRef, useState } from 'react'

// Defer external preview text updates during selection so React cannot detach the browser’s active anchor/focus nodes mid-drag.
export function usePreserveSectionDuringExternalEdit(
  content: string,
  bodyRef: React.RefObject<HTMLDivElement | null>
): string {
  const [renderedContent, setRenderedContent] = useState(content)
  const pendingContentRef = useRef(content)
  pendingContentRef.current = content
  useEffect(() => {
    if (content === renderedContent) {
      return
    }
    const body = bodyRef.current
    const hasSelectionInsideBody = (): boolean => {
      if (!body) {
        return false
      }
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) {
        return false
      }
      const anchor = selection.anchorNode
      const focus = selection.focusNode
      return (
        (anchor instanceof Node && body.contains(anchor)) ||
        (focus instanceof Node && body.contains(focus))
      )
    }
    if (!hasSelectionInsideBody()) {
      setRenderedContent(content)
      return
    }
    // Bound deferral so an abandoned selection cannot freeze a preview while disk keeps changing.
    const MAX_DEFER_MS = 3000
    const deadline = performance.now() + MAX_DEFER_MS
    let frameId = 0
    const waitForSelectionRelease = (): void => {
      if (performance.now() >= deadline || !hasSelectionInsideBody()) {
        setRenderedContent(pendingContentRef.current)
        return
      }
      frameId = window.requestAnimationFrame(waitForSelectionRelease)
    }
    frameId = window.requestAnimationFrame(waitForSelectionRelease)
    return () => window.cancelAnimationFrame(frameId)
  }, [bodyRef, content, renderedContent])
  return renderedContent
}
