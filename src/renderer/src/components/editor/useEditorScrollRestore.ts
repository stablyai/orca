import { useLayoutEffect, type RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'

/**
 * Saves and restores scroll position for the rich markdown editor.
 * Extracted to keep the editor component under the max-lines lint limit.
 */
export function useEditorScrollRestore(
  scrollContainerRef: RefObject<HTMLDivElement | null>,
  scrollCacheKey: string,
  editor: Editor | null
): void {
  // Save scroll position with trailing throttle and synchronous unmount snapshot.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }

    let throttleTimer: ReturnType<typeof setTimeout> | null = null

    const onScroll = (): void => {
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      throttleTimer = setTimeout(() => {
        // Why: a scroll burst while hidden (layout re-drop) must not overwrite the blur-time snapshot.
        if (!document.hidden) {
          setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
        }
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
      setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
    }
    const reanchorAfterReveal = (): void => {
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
      // Why: During React StrictMode double-mount (or rapid mount/unmount before
      // Tiptap renders content), the container has zero scrollable height and
      // scrollTop is 0. Saving that would clobber a valid cached position from
      // the previous session. Only save when the container was scrollable
      // (content was rendered) or the user had scrolled.
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
  }, [scrollContainerRef, scrollCacheKey])

  // Restore scroll position with RAF retry loop for async Tiptap content.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const targetScrollTop = scrollTopCache.get(scrollCacheKey)
    if (!container || targetScrollTop === undefined) {
      return
    }

    let frameId = 0
    let attempts = 0

    // Why: Tiptap renders asynchronously as it hydrates its ProseMirror document,
    // so scrollHeight may be undersized on the initial frame. Retry up to 30
    // frames (~500ms at 60fps) to accommodate content loading. This matches
    // CombinedDiffViewer's proven pattern for dynamic-height content restoration.
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
    // Why: `editor` is included so the effect re-runs when the Tiptap editor
    // instance becomes available (non-null). With `immediatelyRender: false`,
    // editor is null on the first render, so the retry loop would start before
    // content is mounted and exhaust its 30 frames before Tiptap hydrates.
  }, [scrollContainerRef, scrollCacheKey, editor])
}
