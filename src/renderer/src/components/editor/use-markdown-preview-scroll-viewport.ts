import { useLayoutEffect } from 'react'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'

export function useMarkdownPreviewScrollViewport({
  foundation,
  scrollCacheKey,
  restorePixels = true
}: {
  foundation: MarkdownPreviewFoundation
  restorePixels?: boolean
  scrollCacheKey: string
}): void {
  const { rootRef, renderedContent } = foundation

  useLayoutEffect(() => {
    const container = rootRef.current
    if (!container) {
      return
    }

    let throttleTimer: ReturnType<typeof setTimeout> | null = null
    // The last position read while the document was visible: a throttled save that
    // fires after the window was hidden must store this instead of the hidden
    // viewport's (possibly zeroed) scrollTop, and blur then has no live value to
    // flush. Cleared on use so a later visible save reads the live position again.
    let pendingVisibleScrollTop: number | null = null

    const savePendingScroll = (): void => {
      const visibleScrollTop = pendingVisibleScrollTop
      pendingVisibleScrollTop = null
      if (visibleScrollTop !== null) {
        setWithLRU(scrollTopCache, scrollCacheKey, visibleScrollTop)
      } else if (!document.hidden) {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
      }
    }

    const onScroll = (): void => {
      if (!document.hidden) {
        pendingVisibleScrollTop = container.scrollTop
      }
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      throttleTimer = setTimeout(() => {
        // Why: a scroll burst while hidden (layout re-drop) must not overwrite the
        // last visible snapshot. Accepted wedge risk: macOS can leave document.hidden
        // stuck at true while the window is actually visible (see
        // stale-document-visibility.ts); saves then keep that snapshot until the next
        // blur — restore reuses it rather than fresh reads.
        savePendingScroll()
        throttleTimer = null
      }, 150)
    }

    // Why: macOS can drop an occluded window's scroll position; blur flushes the
    // pending save and reveal re-anchors from the cache before the user reads on (#24667).
    const flushPendingSave = (): void => {
      if (throttleTimer === null) {
        return
      }
      clearTimeout(throttleTimer)
      throttleTimer = null
      savePendingScroll()
    }
    const reanchorAfterReveal = (): void => {
      // Why: the pending throttled save holds the newest visible position; flush
      // it so re-anchoring reads that snapshot instead of a stale cache entry.
      flushPendingSave()
      const cached = scrollTopCache.get(scrollCacheKey)
      if (
        cached === undefined ||
        cached <= 1 ||
        container.scrollTop > 1 ||
        container.scrollHeight <= container.clientHeight + 1
      ) {
        return
      }
      container.scrollTop = Math.min(cached, container.scrollHeight - container.clientHeight)
    }
    const onWindowBlur = flushPendingSave
    const onWindowFocus = reanchorAfterReveal
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        reanchorAfterReveal()
      }
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      // Why: StrictMode's zero-height mount must not clobber a valid cached position.
      if (container.scrollHeight > container.clientHeight || container.scrollTop > 0) {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
      }
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      container.removeEventListener('scroll', onScroll)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [rootRef, scrollCacheKey])

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
  }, [rootRef, scrollCacheKey, renderedContent, restorePixels])
}
