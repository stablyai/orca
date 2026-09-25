import { useLayoutEffect, type RefObject } from 'react'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'

export function useIpynbScrollRestoration(
  rootRef: RefObject<HTMLDivElement | null>,
  scrollCacheKey: string,
  content: string
): void {
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
      if (container.scrollHeight > container.clientHeight || container.scrollTop > 0) {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
      }
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      container.removeEventListener('scroll', onScroll)
    }
  }, [rootRef, scrollCacheKey])

  useLayoutEffect(() => {
    const container = rootRef.current
    const targetScrollTop = scrollTopCache.get(scrollCacheKey)
    if (container && targetScrollTop !== undefined) {
      container.scrollTop = targetScrollTop
    }
  }, [rootRef, scrollCacheKey, content])
}
