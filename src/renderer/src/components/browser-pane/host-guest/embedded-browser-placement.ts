import { useCallback, useSyncExternalStore, type CSSProperties } from 'react'
import { clipEmbeddedBrowser } from './embedded-browser-clip'

export type EmbeddedBrowserPlacement = {
  left: number
  top: number
  width: number
  height: number
  clipPath: string
  interactive: boolean
}

const placements = new Map<string, EmbeddedBrowserPlacement>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setEmbeddedBrowserPlacement(
  id: string,
  placement: EmbeddedBrowserPlacement | null
) {
  const previous = placements.get(id)
  if (!previous && !placement) {
    return
  }
  if (
    previous &&
    placement &&
    Object.keys(placement).every(
      (key) =>
        previous[key as keyof EmbeddedBrowserPlacement] ===
        placement[key as keyof EmbeddedBrowserPlacement]
    )
  ) {
    return
  }
  if (placement) {
    placements.set(id, placement)
  } else {
    placements.delete(id)
  }
  for (const listener of listeners) {
    listener()
  }
}

export function useEmbeddedBrowserPlacement(id: string) {
  const snapshot = useCallback(() => placements.get(id) ?? null, [id])
  return useSyncExternalStore(subscribe, snapshot, () => null)
}

export function embeddedBrowserStyle(placement: EmbeddedBrowserPlacement): CSSProperties {
  return {
    position: 'fixed',
    left: placement.left,
    top: placement.top,
    width: placement.width,
    height: placement.height,
    clipPath: placement.clipPath,
    display: 'flex',
    pointerEvents: placement.interactive ? 'auto' : 'none',
    overflow: 'hidden',
    zIndex: 1
  }
}

export function measureEmbeddedBrowserPlacement(
  element: HTMLElement,
  canvas: HTMLElement,
  interactive: boolean,
  occluders: readonly DOMRect[] = []
): EmbeddedBrowserPlacement {
  const rect = element.getBoundingClientRect()
  const bounds = canvas.getBoundingClientRect()
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    interactive,
    clipPath: occluders.length
      ? clipEmbeddedBrowser(rect, bounds, occluders)
      : `inset(${Math.max(0, bounds.top - rect.top)}px ${Math.max(0, rect.right - bounds.right)}px ${Math.max(0, rect.bottom - bounds.bottom)}px ${Math.max(0, bounds.left - rect.left)}px)`
  }
}
