import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceCanvasDocument } from '../../../../shared/maestro-document-contract'
import type { MaestroWorkspaceCanvasResource } from '@/hooks/useMaestroWorkspaceCanvas'
import {
  clampMaestroZoom,
  maestroBoardGridStep,
  panMaestroViewport,
  revealMaestroCanvasBounds,
  type MaestroCanvasBounds,
  type MaestroCanvasInsets,
  type MaestroCanvasSize,
  type MaestroCanvasViewport
} from './maestro-canvas-viewport'
import type { MaestroWorkspaceWindowPlacement } from './maestro-workspace-window-layout'
import { useMaestroViewportElementStyles } from './useMaestroViewportElementStyles'
import { useMaestroViewportPersistence } from './useMaestroViewportPersistence'
import { useMaestroViewportWheel } from './useMaestroViewportWheel'

const DEFAULT_VIEWPORT: MaestroCanvasViewport = { center: { x: 0, y: 0 }, zoom: 1 }
const VIEWPORT_REVEAL_DURATION_MS = 320

export function useMaestroWorkspaceViewport(params: {
  canvasRevision: number
  persisted: WorkspaceCanvasDocument['viewport']
  placements: Readonly<Record<string, MaestroWorkspaceWindowPlacement>>
  resource: MaestroWorkspaceCanvasResource
  mutationIdentity: string
}) {
  const [viewport, setViewport] = useState<MaestroCanvasViewport>(
    params.persisted ?? DEFAULT_VIEWPORT
  )
  const viewportRef = useRef(viewport)
  const [size, setSize] = useState<MaestroCanvasSize>({ width: 1, height: 1 })
  const sizeRef = useRef(size)
  const animationFrameRef = useRef<number | null>(null)
  const viewportStyles = useMaestroViewportElementStyles(viewportRef, sizeRef)
  const [canvasElement, setCanvasElement] = useState<HTMLElement | null>(null)
  const canvasRef = useCallback((node: HTMLElement | null): void => {
    if (node) {
      setCanvasElement(node)
    }
  }, [])
  const persistence = useMaestroViewportPersistence(params.resource.mutate, params.mutationIdentity)
  const pan = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const persistedX = params.persisted?.center.x ?? DEFAULT_VIEWPORT.center.x
  const persistedY = params.persisted?.center.y ?? DEFAULT_VIEWPORT.center.y
  const persistedZoom = params.persisted?.zoom ?? DEFAULT_VIEWPORT.zoom

  useEffect(() => {
    if (pan.current || persistence.isBusy() || animationFrameRef.current !== null) {
      return
    }
    const persisted = { center: { x: persistedX, y: persistedY }, zoom: persistedZoom }
    viewportRef.current = persisted
    setViewport(persisted)
    viewportStyles.apply(persisted)
  }, [params.canvasRevision, persistedX, persistedY, persistedZoom, persistence, viewportStyles])
  useEffect(() => {
    const node = canvasElement
    if (!node) {
      return
    }
    if (typeof ResizeObserver === 'undefined') {
      const bounds = node.getBoundingClientRect()
      const nextSize = { width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) }
      sizeRef.current = nextSize
      setSize(nextSize)
      viewportStyles.apply(viewportRef.current, nextSize)
      return
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        const nextSize = { width: entry.contentRect.width, height: entry.contentRect.height }
        sizeRef.current = nextSize
        setSize(nextSize)
        viewportStyles.apply(viewportRef.current, nextSize)
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [canvasElement, viewportStyles])
  const cancelAnimation = useCallback((syncState: boolean): void => {
    if (animationFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(animationFrameRef.current)
    animationFrameRef.current = null
    if (syncState) {
      setViewport(viewportRef.current)
    }
  }, [])

  const { cancelWheelFrame, onWheel } = useMaestroViewportWheel({
    viewportRef,
    size,
    setViewport,
    cancelAnimation,
    viewportStyles,
    persistence
  })
  useEffect(() => () => cancelAnimation(false), [cancelAnimation])

  const update = useCallback(
    (next: MaestroCanvasViewport): void => {
      cancelAnimation(false)
      cancelWheelFrame(false)
      viewportRef.current = next
      setViewport(next)
      viewportStyles.apply(next)
      persistence.commit(next)
    },
    [cancelAnimation, cancelWheelFrame, persistence, viewportStyles]
  )

  const animateTo = useCallback(
    (next: MaestroCanvasViewport): void => {
      cancelAnimation(false)
      cancelWheelFrame(false)
      const start = viewportRef.current
      const unchanged =
        start.center.x === next.center.x &&
        start.center.y === next.center.y &&
        start.zoom === next.zoom
      if (unchanged) {
        return
      }
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        update(next)
        return
      }
      const startedAt = performance.now()
      const frame = (timestamp: number): void => {
        const progress = Math.min(1, (timestamp - startedAt) / VIEWPORT_REVEAL_DURATION_MS)
        const eased = 1 - (1 - progress) ** 3
        const current = {
          center: {
            x: start.center.x + (next.center.x - start.center.x) * eased,
            y: start.center.y + (next.center.y - start.center.y) * eased
          },
          zoom: start.zoom + (next.zoom - start.zoom) * eased
        }
        viewportRef.current = current
        viewportStyles.apply(current)
        if (progress < 1) {
          animationFrameRef.current = requestAnimationFrame(frame)
          return
        }
        animationFrameRef.current = null
        viewportRef.current = next
        setViewport(next)
        persistence.commit(next)
      }
      animationFrameRef.current = requestAnimationFrame(frame)
    },
    [cancelAnimation, cancelWheelFrame, persistence, update, viewportStyles]
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      if (event.target !== event.currentTarget || event.button !== 0) {
        return
      }
      cancelAnimation(true)
      cancelWheelFrame(true)
      pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [cancelAnimation, cancelWheelFrame]
  )
  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      const current = pan.current
      if (!current || current.pointerId !== event.pointerId) {
        return
      }
      const currentViewport = viewportRef.current
      const next = panMaestroViewport(currentViewport, {
        x: event.clientX - current.x,
        y: event.clientY - current.y
      })
      pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
      viewportRef.current = next
      viewportStyles.schedulePan()
    },
    [viewportStyles]
  )
  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      if (pan.current?.pointerId !== event.pointerId) {
        return
      }
      pan.current = null
      viewportStyles.flushPan()
      setViewport(viewportRef.current)
      persistence.commit(viewportRef.current)
    },
    [persistence, viewportStyles]
  )

  const zoom = useCallback(
    (factor: number) => {
      const current = viewportRef.current
      update({ ...current, zoom: clampMaestroZoom(current.zoom * factor) })
    },
    [update]
  )
  const reset = useCallback(() => animateTo(DEFAULT_VIEWPORT), [animateTo])
  const reveal = useCallback(
    (bounds: MaestroCanvasBounds, insets: MaestroCanvasInsets): void => {
      const current = viewportRef.current
      const next = revealMaestroCanvasBounds(current, size, bounds, insets)
      if (next !== current) {
        animateTo(next)
      }
    },
    [animateTo, size]
  )
  const fit = useCallback(() => {
    const values = Object.values(params.placements)
    if (!values.length) {
      return reset()
    }
    const left = Math.min(...values.map((item) => item.position.x))
    const top = Math.min(...values.map((item) => item.position.y))
    const right = Math.max(...values.map((item) => item.position.x + item.size.width))
    const bottom = Math.max(...values.map((item) => item.position.y + item.size.height))
    animateTo({
      center: { x: (left + right) / 2, y: (top + bottom) / 2 },
      zoom: clampMaestroZoom(
        Math.min(size.width / (right - left + 80), size.height / (bottom - top + 80))
      )
    })
  }, [animateTo, params.placements, reset, size])
  const clientPointToWorld = useCallback(
    (point: { x: number; y: number }): { x: number; y: number } => {
      const bounds = canvasElement?.getBoundingClientRect()
      const canvasSize = sizeRef.current
      const local = {
        x: point.x - (bounds?.left ?? 0),
        y: point.y - (bounds?.top ?? 0)
      }
      const current = viewportRef.current
      return {
        x: current.center.x + (local.x - canvasSize.width / 2) / current.zoom,
        y: current.center.y + (local.y - canvasSize.height / 2) / current.zoom
      }
    },
    [canvasElement]
  )

  const gridStep = maestroBoardGridStep(viewport.zoom) * viewport.zoom
  return {
    rootRef: viewportStyles.rootRef,
    canvasRef,
    viewportReady: size.width > 1 && size.height > 1,
    viewport,
    size,
    zoom,
    reset,
    fit,
    reveal,
    clientPointToWorld,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    canvasStyle: {
      backgroundSize: `var(--maestro-grid-size, ${gridStep}px ${gridStep}px)`,
      backgroundPosition: `var(--maestro-grid-position, ${size.width / 2 - viewport.center.x * viewport.zoom}px ${size.height / 2 - viewport.center.y * viewport.zoom}px)`
    },
    worldStyle: {
      left: '50%',
      top: '50%',
      transform: `var(--maestro-world-transform, translate(${-viewport.center.x * viewport.zoom}px, ${-viewport.center.y * viewport.zoom}px) scale(${viewport.zoom}))`,
      transformOrigin: '0 0'
    }
  }
}
