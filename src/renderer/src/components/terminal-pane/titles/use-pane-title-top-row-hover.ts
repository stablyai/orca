import { useEffect, type RefObject } from 'react'

const TOP_ROW_HOVER_ATTR = 'data-top-row-hover'

function chromelessBarAtPoint(
  layer: HTMLElement,
  clientX: number,
  clientY: number
): HTMLElement | null {
  for (const bar of layer.querySelectorAll<HTMLElement>('.pane-title-bar[data-chromeless]')) {
    const rect = bar.getBoundingClientRect()
    if (
      clientX >= rect.left &&
      clientX < rect.right &&
      clientY >= rect.top &&
      clientY < rect.bottom
    ) {
      return bar
    }
  }
  return null
}

/** Marks the chromeless title bar under the pointer; the bar passes pointer events through, so CSS :hover cannot see the terminal row beneath it. */
export function usePaneTitleTopRowHover(layerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const layer = layerRef.current
    const host = layer?.parentElement
    if (!layer || !host) {
      return
    }
    let hoveredBar: HTMLElement | null = null
    const setHoveredBar = (bar: HTMLElement | null): void => {
      if (bar === hoveredBar) {
        return
      }
      hoveredBar?.removeAttribute(TOP_ROW_HOVER_ATTR)
      bar?.setAttribute(TOP_ROW_HOVER_ATTR, '')
      hoveredBar = bar
    }
    const onPointerMove = (event: PointerEvent): void => {
      setHoveredBar(chromelessBarAtPoint(layer, event.clientX, event.clientY))
    }
    const onPointerLeave = (): void => setHoveredBar(null)
    host.addEventListener('pointermove', onPointerMove, { passive: true })
    host.addEventListener('pointerleave', onPointerLeave)
    return () => {
      host.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerleave', onPointerLeave)
      setHoveredBar(null)
    }
  }, [layerRef])
}
