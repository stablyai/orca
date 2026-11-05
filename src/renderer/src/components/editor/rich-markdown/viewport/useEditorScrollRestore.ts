import { useLayoutEffect, type RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'

export function useEditorScrollRestore(
  scrollContainerRef: RefObject<HTMLDivElement | null>,
  scrollCacheKey: string,
  editor: Editor | null
): void {
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
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
        throttleTimer = null
      }, 150)
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      // Zero-height StrictMode/early cleanup must not overwrite a valid cached scroll position before content renders.
      if (container.scrollHeight > container.clientHeight || container.scrollTop > 0) {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
      }
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      container.removeEventListener('scroll', onScroll)
    }
  }, [scrollContainerRef, scrollCacheKey])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const targetScrollTop = scrollTopCache.get(scrollCacheKey)
    if (!container || targetScrollTop === undefined) {
      return
    }

    let frameId = 0
    let attempts = 0

    // Retry while asynchronous Tiptap hydration grows scrollHeight; the initial frame may not reach the cached offset.
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
    // Restart when the editor becomes available or the retry budget could expire before hydration mounts content.
  }, [scrollContainerRef, scrollCacheKey, editor])
}
