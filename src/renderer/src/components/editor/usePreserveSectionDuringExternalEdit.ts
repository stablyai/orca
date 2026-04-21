import { useEffect, useRef, useState } from 'react'

// Why: when the .md file is being modified externally (e.g. the AI is
// streaming writes), each external-change event replaces the `content`
// prop, which makes react-markdown replace the rendered text nodes. Any
// in-progress browser selection inside the preview collapses mid-drag
// because its anchor/focus nodes are detached. This hook holds back content
// updates while the user has an active selection inside the preview body
// and applies the latest pending content once the selection is released.
export function usePreserveSectionDuringExternalEdit(
  content: string,
  bodyRef: React.RefObject<HTMLDivElement>
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
    let frameId = 0
    const waitForSelectionRelease = (): void => {
      if (hasSelectionInsideBody()) {
        frameId = window.requestAnimationFrame(waitForSelectionRelease)
        return
      }
      setRenderedContent(pendingContentRef.current)
    }
    frameId = window.requestAnimationFrame(waitForSelectionRelease)
    return () => window.cancelAnimationFrame(frameId)
  }, [content, renderedContent])
  return renderedContent
}
