import React, { useLayoutEffect, useRef } from 'react'
import { useEditorSurfaceAppearance } from './use-editor-surface-appearance'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import MermaidBlock from './MermaidBlock'

type MermaidViewerProps = {
  content: string
  filePath: string
}

/**
 * Full-file Mermaid diagram view, the counterpart to MermaidBlock (fenced blocks inside markdown).
 * Why: a .mmd / .mermaid file in diagram mode is pure diagram source — no markdown wrapper, no frontmatter.
 */
export default function MermaidViewer({
  content,
  filePath
}: MermaidViewerProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const { isDark } = useEditorSurfaceAppearance()

  // Why: Each viewing mode (source vs diagram) produces different DOM heights.
  // Mode-scoped keys prevent restoring a source-mode scroll position in diagram
  // mode (same reasoning as MarkdownPreview's scrollCacheKey).
  const scrollCacheKey = `${filePath}:mermaid-diagram`

  useLayoutEffect(() => {
    const container = rootRef.current
    if (!container) {
      return
    }

    let throttleTimer: ReturnType<typeof setTimeout> | null = null

    const onScroll = (): void => {
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      throttleTimer = setTimeout(() => {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
        throttleTimer = null
      }, 150)
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      // Why: guard against writing 0 when the SVG has not rendered yet (e.g.,
      // StrictMode double-mount or quick tab switch before mermaid.render()
      // completes). Without this, a valid cached position gets clobbered.
      if (container.scrollHeight > container.clientHeight || container.scrollTop > 0) {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
      }
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      container.removeEventListener('scroll', onScroll)
    }
  }, [scrollCacheKey])

  useLayoutEffect(() => {
    const container = rootRef.current
    const targetScrollTop = scrollTopCache.get(scrollCacheKey)
    if (!container || targetScrollTop === undefined) {
      return
    }

    let frameId = 0
    let attempts = 0

    // Why: mermaid.render() is async, so the SVG may not exist on the first
    // frame. Retry up to 30 frames (~500ms) to match MarkdownPreview's pattern.
    const tryRestore = (): void => {
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
      const nextScrollTop = Math.min(targetScrollTop, maxScrollTop)
      container.scrollTop = nextScrollTop

      if (Math.abs(container.scrollTop - targetScrollTop) <= 1 || maxScrollTop >= targetScrollTop) {
        return
      }

      attempts += 1
      if (attempts < 30) {
        frameId = window.requestAnimationFrame(tryRestore)
      }
    }

    tryRestore()
    return () => window.cancelAnimationFrame(frameId)
  }, [scrollCacheKey, content])

  return (
    <div ref={rootRef} className="mermaid-viewer h-full min-h-0 overflow-auto scrollbar-editor">
      <div className="mermaid-viewer-canvas">
        {/* Why: DOMPurify's SVG profile strips <foreignObject> elements that
           mermaid uses for HTML labels. Force SVG-native <text> labels so
           they survive sanitization — same fix as the markdown preview path. */}
        <MermaidBlock content={content.trim()} isDark={isDark} htmlLabels={false} />
      </div>
    </div>
  )
}
