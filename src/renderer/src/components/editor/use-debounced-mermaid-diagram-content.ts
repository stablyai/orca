import { useEffect, useRef, useState } from 'react'

export const MERMAID_RENDER_DEBOUNCE_MS = 250

export function useDebouncedMermaidDiagramContent(content: string, resetKey?: unknown): string {
  const [debouncedContent, setDebouncedContent] = useState(content)
  const previousResetKeyRef = useRef(resetKey)

  useEffect(() => {
    if (resetKey !== previousResetKeyRef.current) {
      previousResetKeyRef.current = resetKey
      setDebouncedContent(content)
      return
    }

    if (content.length === 0) {
      setDebouncedContent('')
      return
    }

    const timer = window.setTimeout(() => {
      setDebouncedContent(content)
    }, MERMAID_RENDER_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [content, resetKey])

  return debouncedContent
}
