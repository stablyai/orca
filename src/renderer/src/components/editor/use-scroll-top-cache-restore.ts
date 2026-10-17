import { useLayoutEffect, type RefObject } from 'react'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'

export function useScrollTopCacheRestore(
  scrollContainerRef: RefObject<HTMLDivElement | null>,
  scrollCacheKey: string | undefined,
  restoreKey: unknown
): void {
  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    if (!container || !scrollCacheKey) {
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
      if (container.scrollHeight > container.clientHeight || container.scrollTop > 0) {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
      }
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      container.removeEventListener('scroll', onScroll)
    }
  }, [scrollCacheKey, scrollContainerRef])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const targetScrollTop = scrollCacheKey ? scrollTopCache.get(scrollCacheKey) : undefined
    if (!container || targetScrollTop === undefined) {
      return
    }

    let frameId = 0
    let attempts = 0
    const tryRestore = (): void => {
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
      container.scrollTop = Math.min(targetScrollTop, maxScrollTop)
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
  }, [restoreKey, scrollCacheKey, scrollContainerRef])
}
