import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import {
  maestroBoardGridStep,
  type MaestroCanvasSize,
  type MaestroCanvasViewport
} from './maestro-canvas-viewport'

function applyViewportStyles(
  element: HTMLElement | null,
  viewport: MaestroCanvasViewport,
  size: MaestroCanvasSize
): void {
  if (!element) {
    return
  }
  const gridStep = maestroBoardGridStep(viewport.zoom) * viewport.zoom
  element.style.setProperty('--maestro-grid-size', `${gridStep}px ${gridStep}px`)
  element.style.setProperty(
    '--maestro-grid-position',
    `${size.width / 2 - viewport.center.x * viewport.zoom}px ${size.height / 2 - viewport.center.y * viewport.zoom}px`
  )
  element.style.setProperty(
    '--maestro-world-transform',
    `translate(${-viewport.center.x * viewport.zoom}px, ${-viewport.center.y * viewport.zoom}px) scale(${viewport.zoom})`
  )
}

export function useMaestroViewportElementStyles(
  viewportRef: MutableRefObject<MaestroCanvasViewport>,
  sizeRef: MutableRefObject<MaestroCanvasSize>
) {
  const rootElementRef = useRef<HTMLElement | null>(null)
  const panFrameRef = useRef<number | null>(null)
  const rootRef = useCallback(
    (node: HTMLElement | null): void => {
      rootElementRef.current = node
      applyViewportStyles(node, viewportRef.current, sizeRef.current)
    },
    [sizeRef, viewportRef]
  )
  const apply = useCallback(
    (viewport: MaestroCanvasViewport, size = sizeRef.current): void => {
      applyViewportStyles(rootElementRef.current, viewport, size)
    },
    [sizeRef]
  )
  const schedulePan = useCallback((): void => {
    if (panFrameRef.current !== null) {
      return
    }
    panFrameRef.current = requestAnimationFrame(() => {
      panFrameRef.current = null
      applyViewportStyles(rootElementRef.current, viewportRef.current, sizeRef.current)
    })
  }, [sizeRef, viewportRef])
  const flushPan = useCallback((): void => {
    if (panFrameRef.current !== null) {
      cancelAnimationFrame(panFrameRef.current)
      panFrameRef.current = null
    }
    applyViewportStyles(rootElementRef.current, viewportRef.current, sizeRef.current)
  }, [sizeRef, viewportRef])

  useEffect(
    () => () => {
      if (panFrameRef.current !== null) {
        cancelAnimationFrame(panFrameRef.current)
      }
    },
    []
  )

  return useMemo(
    () => ({ rootRef, apply, schedulePan, flushPan }),
    [apply, flushPan, rootRef, schedulePan]
  )
}
