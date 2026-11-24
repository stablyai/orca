import type React from 'react'
import { cn } from '@/lib/class-names'
import type { PanZoomSize } from '../../../../../shared/document-preview/pan-zoom-view'
import type { PanZoomViewport } from '../viewer-viewport/use-pan-zoom-viewport'

const CURSOR_CLASS = {
  'zoom-in': 'cursor-zoom-in',
  'zoom-out': 'cursor-zoom-out',
  grab: 'cursor-grab',
  grabbing: 'cursor-grabbing'
} as const

/** The click-to-zoom, Alt-drag-to-pan canvas and its positioned image; callers own the controls around it. */
export function PanZoomImageSurface({
  panZoom,
  src,
  alt,
  content,
  className,
  background,
  backdrop = false,
  fallback,
  onLoad,
  onError
}: {
  panZoom: PanZoomViewport
  src: string | null
  alt: string
  content: PanZoomSize | null
  className?: string
  background?: string
  /** Over a see-through backdrop: the background fills only the image, and only the image shows a zoom cursor. */
  backdrop?: boolean
  /** Shown instead of the image while it has no source. */
  fallback?: React.ReactNode
  onLoad?: React.ReactEventHandler<HTMLImageElement>
  onError?: React.ReactEventHandler<HTMLImageElement>
}): React.JSX.Element {
  const { setCanvas, canvasHandlers, cursor, scale, offset } = panZoom
  const imageCursor = backdrop && (cursor === 'zoom-in' || cursor === 'zoom-out')
  const backgroundStyle = background ? { backgroundColor: background } : undefined
  return (
    <div
      ref={setCanvas}
      data-testid="pan-zoom-image-canvas"
      className={cn(
        'touch-none overflow-hidden',
        src && cursor && !imageCursor && CURSOR_CLASS[cursor],
        className
      )}
      style={backdrop ? undefined : backgroundStyle}
      {...canvasHandlers}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={onLoad}
          onError={onError}
          className={cn(
            'absolute top-0 left-0 max-w-none select-none',
            // Hit-testable only to show the zoom cursor; presses still reach the canvas.
            imageCursor ? CURSOR_CLASS[cursor] : 'pointer-events-none',
            !offset && 'invisible'
          )}
          style={
            content && offset
              ? {
                  ...(backdrop ? backgroundStyle : undefined),
                  // Size the box rather than scale it, so an SVG redraws sharply at every zoom.
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
  )
}
