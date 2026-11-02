import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Maximize, X, ZoomIn, ZoomOut } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  IMAGE_VIEWER_ZOOM_STEP,
  MIN_IMAGE_VIEWER_ZOOM,
  getPinchZoomFactor,
  getWheelDeltaPixels
} from './image-viewer-zoom'
import {
  type DiagramPoint,
  type DiagramSize,
  type DiagramView,
  getDiagramFitScale,
  getDiagramViewOffset,
  getFittedDiagramView,
  getMaxDiagramZoom,
  panDiagramView,
  zoomDiagramViewAt
} from './diagram-pan-zoom'

function readSvgImage(svg: string): { xml: string; size: DiagramSize } | null {
  // Why: sanitized SVG is HTML-serialized (`&nbsp;`), which an XML image document rejects.
  const element = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg')
  const [, , width, height] = (element?.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (!element || !(width > 0 && height > 0)) {
    return null
  }
  return { xml: new XMLSerializer().serializeToString(element), size: { width, height } }
}

function useSvgObjectUrl(xml: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (xml === null) {
      setUrl(null)
      return
    }
    // Why: an image document keeps the copy's ids and styles out of the page that still shows the original.
    const next = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [xml])
  return url
}

function ToolbarButton({
  label,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export default function DiagramViewerModal(): React.JSX.Element {
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const svg = typeof modalData.svg === 'string' ? modalData.svg : ''
  const background = typeof modalData.background === 'string' ? modalData.background : undefined

  const image = useMemo(() => readSvgImage(svg), [svg])
  const url = useSvgObjectUrl(image?.xml ?? null)
  const diagram = image?.size ?? null
  // Why: state, not a ref — the dialog portal mounts the canvas after this component's first effects.
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null)
  const openerRef = useRef<Element | null>(null)
  const dragRef = useRef<DiagramPoint | null>(null)
  const [viewport, setViewport] = useState<DiagramSize | null>(null)
  // null is the fitted view, so it follows the canvas as it resizes.
  const [manualView, setManualView] = useState<DiagramView | null>(null)
  const [dragging, setDragging] = useState(false)

  const geometry = useMemo(() => {
    if (!diagram || !viewport) {
      return null
    }
    return { diagram, viewport, fitScale: getDiagramFitScale(diagram, viewport) }
  }, [diagram, viewport])
  const view = manualView ?? (diagram ? getFittedDiagramView(diagram) : null)

  useEffect(() => {
    if (!canvas) {
      return
    }
    const observer = new ResizeObserver(() =>
      setViewport({ width: canvas.clientWidth, height: canvas.clientHeight })
    )
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [canvas])

  useEffect(() => {
    if (!canvas || !geometry) {
      return
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const fitted = getFittedDiagramView(geometry.diagram)
      if (event.ctrlKey) {
        const rect = canvas.getBoundingClientRect()
        const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
        setManualView((current) => {
          const from = current ?? fitted
          return zoomDiagramViewAt({
            ...geometry,
            view: from,
            nextZoom: from.zoom * getPinchZoomFactor(event.deltaY, event.deltaMode),
            anchor
          })
        })
        return
      }
      // Why: Windows and Linux report Shift+wheel as vertical; macOS already swaps the axis.
      const sideways = event.shiftKey && event.deltaX === 0
      const deltaX = getWheelDeltaPixels(event.deltaX, event.deltaMode)
      const deltaY = getWheelDeltaPixels(event.deltaY, event.deltaMode)
      const delta = sideways ? { x: -deltaY, y: 0 } : { x: -deltaX, y: -deltaY }
      setManualView((current) => {
        const from = current ?? fitted
        return panDiagramView(from, delta, geometry.fitScale * from.zoom, geometry.diagram)
      })
    }
    // Why: React's wheel listener is passive, so it cannot stop the page zooming on pinch.
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [canvas, geometry])

  const stepZoom = (factor: number): void => {
    if (!geometry || !view) {
      return
    }
    setManualView(
      zoomDiagramViewAt({
        ...geometry,
        view,
        nextZoom: view.zoom * factor,
        anchor: { x: geometry.viewport.width / 2, y: geometry.viewport.height / 2 }
      })
    )
  }

  const endDrag = (): void => {
    dragRef.current = null
    setDragging(false)
  }

  const scale = geometry && view ? geometry.fitScale * view.zoom : 0
  const offset = geometry && view ? getDiagramViewOffset(view, geometry.viewport, scale) : null
  const title = translate('auto.components.editor.DiagramViewerModal.title', 'Diagram')

  return (
    <Dialog open onOpenChange={(open) => !open && closeModal()}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        className="h-[90dvh] w-[90vw] max-w-[90vw] overflow-hidden sm:max-w-[90vw]"
        onOpenAutoFocus={(event) => {
          // Why: a root-hosted dialog has no trigger, so remember the opener before focus moves in.
          openerRef.current = document.activeElement
          // Why: focusing a toolbar button would pop its tooltip, and the first Escape would only close that.
          if (event.currentTarget instanceof HTMLElement) {
            event.preventDefault()
            event.currentTarget.focus()
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const opener = openerRef.current
          // Why: a modal that replaced this one owns focus now.
          if (
            opener instanceof HTMLElement &&
            opener.isConnected &&
            useAppStore.getState().activeModal === 'none'
          ) {
            opener.focus({ preventScroll: true })
          }
        }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {/* Why: pinned to the dialog edges so its own padding does not frame the canvas. */}
        <div
          ref={setCanvas}
          data-testid="diagram-viewer-canvas"
          className={cn(
            'absolute inset-0 touch-none overflow-hidden bg-background',
            dragging ? 'cursor-grabbing' : 'cursor-grab'
          )}
          style={background ? { backgroundColor: background } : undefined}
          onPointerDown={(event) => {
            if (event.button !== 0) {
              return
            }
            event.currentTarget.setPointerCapture(event.pointerId)
            dragRef.current = { x: event.clientX, y: event.clientY }
            setDragging(true)
          }}
          onPointerMove={(event) => {
            const last = dragRef.current
            if (!last || !geometry) {
              return
            }
            dragRef.current = { x: event.clientX, y: event.clientY }
            const delta = { x: event.clientX - last.x, y: event.clientY - last.y }
            // Why: several moves can land before one render, so each must build on the last.
            setManualView((current) => {
              const from = current ?? getFittedDiagramView(geometry.diagram)
              return panDiagramView(from, delta, geometry.fitScale * from.zoom, geometry.diagram)
            })
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
        >
          {url && diagram && offset ? (
            <img
              src={url}
              alt={title}
              draggable={false}
              className="pointer-events-none absolute top-0 left-0 max-w-none select-none"
              style={{
                // Why: sizing the box, not scaling it, makes the SVG redraw sharply at every zoom.
                width: diagram.width * scale,
                height: diagram.height * scale,
                transform: `translate(${offset.x}px, ${offset.y}px)`
              }}
            />
          ) : null}
        </div>
        <div className="absolute top-3 right-3 flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-xs">
          <ToolbarButton
            label={translate('auto.components.editor.DiagramViewerModal.zoomOut', 'Zoom out')}
            disabled={!view || view.zoom <= MIN_IMAGE_VIEWER_ZOOM}
            onClick={() => stepZoom(1 / IMAGE_VIEWER_ZOOM_STEP)}
          >
            <ZoomOut />
          </ToolbarButton>
          <ToolbarButton
            label={translate('auto.components.editor.DiagramViewerModal.zoomIn', 'Zoom in')}
            disabled={!view || !geometry || view.zoom >= getMaxDiagramZoom(geometry.fitScale)}
            onClick={() => stepZoom(IMAGE_VIEWER_ZOOM_STEP)}
          >
            <ZoomIn />
          </ToolbarButton>
          <ToolbarButton
            label={translate('auto.components.editor.DiagramViewerModal.fit', 'Fit to screen')}
            disabled={manualView === null}
            onClick={() => setManualView(null)}
          >
            <Maximize />
          </ToolbarButton>
          <ToolbarButton
            label={translate('auto.components.editor.DiagramViewerModal.close', 'Close')}
            onClick={closeModal}
          >
            <X />
          </ToolbarButton>
        </div>
      </DialogContent>
    </Dialog>
  )
}
