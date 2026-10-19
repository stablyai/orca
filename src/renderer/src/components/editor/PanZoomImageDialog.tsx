import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Maximize, X, ZoomIn, ZoomOut } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
  type PanZoomPoint,
  type PanZoomSize,
  type PanZoomView,
  getFittedPanZoomView,
  getMaxPanZoom,
  getPanZoomFitScale,
  getPanZoomViewOffset,
  panView,
  zoomViewAt
} from './pan-zoom-view'

type PanZoomImageDialogProps = Omit<
  React.ComponentProps<typeof DialogContent>,
  'children' | 'className' | 'showCloseButton' | 'onOpenAutoFocus' | 'onCloseAutoFocus' | 'size'
> & {
  open: boolean
  onOpenChange: (open: boolean) => void
  src: string | null | undefined
  /** For an image with no intrinsic size, like an SVG sized only by its viewBox; read on load otherwise. */
  size?: PanZoomSize | null
  title: string
  /** Shows the title in the corner; otherwise only screen readers hear it. */
  showTitle?: boolean
  background?: string
  /** Shown instead of the image while it has no source or after it fails to load. */
  fallback?: React.ReactNode
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

/** Full-window image preview the user can drag, wheel or pinch to pan and zoom. */
export function PanZoomImageDialog({
  open,
  onOpenChange,
  src,
  size,
  title,
  showTitle = false,
  background,
  fallback,
  ...contentProps
}: PanZoomImageDialogProps): React.JSX.Element {
  const openerRef = useRef<Element | null>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        {...contentProps}
        showCloseButton={false}
        className="h-[90dvh] w-[90vw] max-w-[90vw] overflow-hidden sm:max-w-[90vw]"
        onOpenAutoFocus={(event) => {
          // Why: a dialog opened without a trigger has nothing to return to, so remember the opener.
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
        {/* Why: mounted with the content, so every opening starts from the fitted view. */}
        <PanZoomImageCanvas
          src={src}
          size={size}
          title={title}
          showTitle={showTitle}
          background={background}
          fallback={fallback}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function PanZoomImageCanvas({
  src,
  size,
  title,
  showTitle,
  background,
  fallback,
  onClose
}: Pick<
  PanZoomImageDialogProps,
  'src' | 'size' | 'title' | 'showTitle' | 'background' | 'fallback'
> & { onClose: () => void }): React.JSX.Element {
  // Why: state, not a ref — the dialog portal mounts the canvas after this component's first effects.
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null)
  const dragRef = useRef<PanZoomPoint | null>(null)
  const [viewport, setViewport] = useState<PanZoomSize | null>(null)
  const [loaded, setLoaded] = useState<{
    src: string
    size: PanZoomSize
  } | null>(null)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  // null is the fitted view, so it follows the canvas as it resizes.
  const [manualView, setManualView] = useState<PanZoomView | null>(null)
  const [dragging, setDragging] = useState(false)

  const imageSrc = src && src !== failedSrc ? src : null
  // Why: a view is in its image's pixels, and a pasted thumbnail is swapped for the larger saved file.
  const [viewSrc, setViewSrc] = useState(imageSrc)
  if (viewSrc !== imageSrc) {
    setViewSrc(imageSrc)
    setManualView(null)
  }
  const content = size ?? (loaded && loaded.src === imageSrc ? loaded.size : null)
  const geometry = useMemo(() => {
    if (!content || !viewport) {
      return null
    }
    return {
      content,
      viewport,
      fitScale: getPanZoomFitScale(content, viewport)
    }
  }, [content, viewport])
  const view = manualView ?? (content ? getFittedPanZoomView(content) : null)
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
      const fitted = getFittedPanZoomView(geometry.content)
      if (event.ctrlKey) {
        const rect = canvas.getBoundingClientRect()
        const anchor = {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top
        }
        setManualView((current) => {
          const from = current ?? fitted
          return zoomViewAt({
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
        return panView(from, delta, geometry.fitScale * from.zoom, geometry.content)
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
      zoomViewAt({
        ...geometry,
        view,
        nextZoom: view.zoom * factor,
        anchor: {
          x: geometry.viewport.width / 2,
          y: geometry.viewport.height / 2
        }
      })
    )
  }

  const endDrag = (): void => {
    dragRef.current = null
    setDragging(false)
  }

  const scale = geometry && view ? geometry.fitScale * view.zoom : 0
  const offset = geometry && view ? getPanZoomViewOffset(view, geometry.viewport, scale) : null

  return (
    <>
      {/* Why: pinned to the dialog edges so its own padding does not frame the canvas. */}
      <div
        ref={setCanvas}
        data-testid="pan-zoom-image-canvas"
        className={cn(
          'absolute inset-0 touch-none overflow-hidden bg-background',
          imageSrc && (dragging ? 'cursor-grabbing' : 'cursor-grab')
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
          const delta = {
            x: event.clientX - last.x,
            y: event.clientY - last.y
          }
          // Why: several moves can land before one render, so each must build on the last.
          setManualView((current) => {
            const from = current ?? getFittedPanZoomView(geometry.content)
            return panView(from, delta, geometry.fitScale * from.zoom, geometry.content)
          })
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={title}
            draggable={false}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget
              if (width > 0 && height > 0) {
                setLoaded({ src: imageSrc, size: { width, height } })
              }
            }}
            onError={() => setFailedSrc(imageSrc)}
            className={cn(
              'pointer-events-none absolute top-0 left-0 max-w-none select-none',
              !offset && 'invisible'
            )}
            style={
              content && offset
                ? {
                    // Why: sizing the box, not scaling it, makes an SVG redraw sharply at every zoom.
                    width: content.width * scale,
                    height: content.height * scale,
                    transform: `translate(${offset.x}px, ${offset.y}px)`
                  }
                : undefined
            }
          />
        ) : (
          <div className="flex size-full items-center justify-center">{fallback}</div>
        )}
      </div>
      {showTitle ? (
        <span
          aria-hidden
          className="absolute top-3 left-3 max-w-[calc(100%-10rem)] truncate rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground shadow-xs"
        >
          {title}
        </span>
      ) : null}
      {/* Why: the dialog opens from surfaces outside the app's tooltip provider. */}
      <TooltipProvider>
        <div className="absolute top-3 right-3 flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-xs">
          <ToolbarButton
            label={translate('auto.components.editor.PanZoomImageDialog.zoomOut', 'Zoom out')}
            disabled={!view || view.zoom <= MIN_IMAGE_VIEWER_ZOOM}
            onClick={() => stepZoom(1 / IMAGE_VIEWER_ZOOM_STEP)}
          >
            <ZoomOut />
          </ToolbarButton>
          <ToolbarButton
            label={translate('auto.components.editor.PanZoomImageDialog.zoomIn', 'Zoom in')}
            disabled={!view || !geometry || view.zoom >= getMaxPanZoom(geometry.fitScale)}
            onClick={() => stepZoom(IMAGE_VIEWER_ZOOM_STEP)}
          >
            <ZoomIn />
          </ToolbarButton>
          <ToolbarButton
            label={translate('auto.components.editor.PanZoomImageDialog.fit', 'Fit to screen')}
            disabled={manualView === null}
            onClick={() => setManualView(null)}
          >
            <Maximize />
          </ToolbarButton>
          <ToolbarButton
            label={translate('auto.components.editor.PanZoomImageDialog.close', 'Close')}
            onClick={onClose}
          >
            <X />
          </ToolbarButton>
        </div>
      </TooltipProvider>
    </>
  )
}
