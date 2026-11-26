import { useEffect, type RefObject } from 'react'

const TOP_ROW_HOVER_ATTR = 'data-top-row-hover'
const CHROMELESS_BAR_SELECTOR = '.pane-title-bar[data-chromeless]'
const FINE_HOVER_MEDIA_QUERY = '(hover: hover) and (pointer: fine)'

type CachedChromelessBar = {
  bar: HTMLElement
  left: number
  right: number
  top: number
  bottom: number
}

function pointInRect(rect: CachedChromelessBar, clientX: number, clientY: number): boolean {
  return (
    clientX >= rect.left && clientX < rect.right && clientY >= rect.top && clientY < rect.bottom
  )
}

function measureChromelessBars(layer: HTMLElement): CachedChromelessBar[] {
  const bars: CachedChromelessBar[] = []
  for (const bar of layer.querySelectorAll<HTMLElement>(CHROMELESS_BAR_SELECTOR)) {
    const rect = bar.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      continue
    }
    bars.push({
      bar,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom
    })
  }
  return bars
}

function attachTopRowHover(layer: HTMLElement, host: HTMLElement): () => void {
  let hoveredEntry: CachedChromelessBar | null = null
  let cachedBars: CachedChromelessBar[] = []
  let cacheDirty = true

  const setHoveredEntry = (entry: CachedChromelessBar | null): void => {
    if (entry?.bar === hoveredEntry?.bar) {
      hoveredEntry = entry
      return
    }
    hoveredEntry?.bar.removeAttribute(TOP_ROW_HOVER_ATTR)
    entry?.bar.setAttribute(TOP_ROW_HOVER_ATTR, '')
    hoveredEntry = entry
  }

  const invalidateCache = (): void => {
    cacheDirty = true
  }

  const ensureCache = (): CachedChromelessBar[] => {
    if (!cacheDirty) {
      return cachedBars
    }
    cachedBars = measureChromelessBars(layer)
    cacheDirty = false
    if (hoveredEntry) {
      const updated = cachedBars.find((entry) => entry.bar === hoveredEntry?.bar) ?? null
      setHoveredEntry(updated)
    }
    return cachedBars
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      return
    }
    const { clientX, clientY } = event
    // Avoid revealing chromeless headers during terminal text selection or pane drags.
    if (event.buttons !== 0) {
      if (hoveredEntry) {
        // Refresh at most once per invalidation so a stale rect cannot keep the reveal pinned.
        ensureCache()
        if (hoveredEntry && !pointInRect(hoveredEntry, clientX, clientY)) {
          setHoveredEntry(null)
        }
      }
      return
    }
    if (!cacheDirty && hoveredEntry && pointInRect(hoveredEntry, clientX, clientY)) {
      return
    }
    const bars = ensureCache()
    let hit: CachedChromelessBar | null = null
    for (const entry of bars) {
      if (pointInRect(entry, clientX, clientY)) {
        hit = entry
        break
      }
    }
    setHoveredEntry(hit)
  }

  const onPointerLeave = (): void => {
    setHoveredEntry(null)
    invalidateCache()
  }

  const onScroll = (event: Event): void => {
    const target = event.target
    if (target instanceof Node && !target.contains(host)) {
      return
    }
    invalidateCache()
  }

  const mutationObserver = new MutationObserver((records) => {
    let relevant = false
    for (const record of records) {
      if (record.type === 'childList') {
        if (record.target === layer) {
          relevant = true
          break
        }
      } else if (
        record.target === layer ||
        (record.target instanceof Element && record.target.classList.contains('pane-title-bar'))
      ) {
        relevant = true
        break
      }
    }
    if (!relevant) {
      return
    }
    invalidateCache()
    if (
      hoveredEntry &&
      (!hoveredEntry.bar.isConnected || !hoveredEntry.bar.hasAttribute('data-chromeless'))
    ) {
      setHoveredEntry(null)
    }
  })
  mutationObserver.observe(layer, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-chromeless', 'style']
  })

  const resizeObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(invalidateCache) : null
  resizeObserver?.observe(host)

  host.addEventListener('pointerenter', invalidateCache, { passive: true })
  host.addEventListener('pointermove', onPointerMove, { passive: true })
  host.addEventListener('pointerleave', onPointerLeave)
  window.addEventListener('resize', invalidateCache, { passive: true })
  window.addEventListener('scroll', onScroll, { capture: true, passive: true })

  return () => {
    mutationObserver.disconnect()
    resizeObserver?.disconnect()
    host.removeEventListener('pointerenter', invalidateCache)
    host.removeEventListener('pointermove', onPointerMove)
    host.removeEventListener('pointerleave', onPointerLeave)
    window.removeEventListener('resize', invalidateCache)
    window.removeEventListener('scroll', onScroll, true)
    setHoveredEntry(null)
    cachedBars = []
    cacheDirty = true
  }
}

/** Marks the chromeless title bar under the pointer; the bar passes pointer events through, so CSS :hover cannot see the terminal row beneath it. */
export function usePaneTitleTopRowHover(layerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const layer = layerRef.current
    const host = layer?.parentElement
    if (!layer || !host) {
      return
    }

    const mediaQuery =
      typeof window.matchMedia === 'function' ? window.matchMedia(FINE_HOVER_MEDIA_QUERY) : null
    let detachListeners: (() => void) | null = null

    const detach = (): void => {
      detachListeners?.()
      detachListeners = null
    }

    const syncAttachment = (): void => {
      if (mediaQuery && !mediaQuery.matches) {
        detach()
      } else if (!detachListeners) {
        detachListeners = attachTopRowHover(layer, host)
      }
    }

    syncAttachment()
    mediaQuery?.addEventListener('change', syncAttachment)

    return () => {
      mediaQuery?.removeEventListener('change', syncAttachment)
      detach()
    }
  }, [layerRef])
}
