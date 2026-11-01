import { useLayoutEffect } from 'react'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import {
  clearMarkdownMermaidScrollAnchor,
  recordMarkdownMermaidScrollAnchor,
  restoreMarkdownMermaidScrollAnchor
} from './markdown-mermaid-scroll-anchor'

export function useMarkdownPreviewScrollViewport({
  foundation,
  scrollCacheKey,
  restorePixels = true
}: {
  foundation: MarkdownPreviewFoundation
  restorePixels?: boolean
  scrollCacheKey: string
}): void {
  const { rootRef, bodyRef, renderedContent } = foundation

  useLayoutEffect(() => {
    if (!restorePixels) {
      clearMarkdownMermaidScrollAnchor(scrollCacheKey)
    }
    const container = rootRef.current
    if (!container) {
      return
    }
    const body = bodyRef.current

    let throttleTimer: ReturnType<typeof setTimeout> | null = null

    const onScroll = (): void => {
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      throttleTimer = setTimeout(() => {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
        if (restorePixels) {
          recordMarkdownMermaidScrollAnchor(container, body, scrollCacheKey)
        }
        throttleTimer = null
      }, 150)
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      // Why: StrictMode's zero-height mount must not clobber a valid cached position.
      if (container.scrollHeight > container.clientHeight || container.scrollTop > 0) {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
        if (restorePixels) {
          recordMarkdownMermaidScrollAnchor(container, body, scrollCacheKey)
        }
      }
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      container.removeEventListener('scroll', onScroll)
    }
  }, [rootRef, bodyRef, scrollCacheKey, restorePixels])

  useLayoutEffect(() => {
    const container = rootRef.current
    if (!restorePixels) {
      return
    }
    const targetScrollTop = scrollTopCache.get(scrollCacheKey)
    if (!container || targetScrollTop === undefined) {
      return
    }

    let frameId = 0
    let attempts = 0
    let cancelRestore: (() => void) | undefined

    const tryRestore = (): void => {
      const restoredAnchor = restoreMarkdownMermaidScrollAnchor(container, scrollCacheKey)
      if (restoredAnchor !== null) {
        cancelRestore = restoredAnchor
        return
      }
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
    return () => {
      window.cancelAnimationFrame(frameId)
      cancelRestore?.()
    }
  }, [rootRef, bodyRef, scrollCacheKey, renderedContent, restorePixels])
}
