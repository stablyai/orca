import type React from 'react'
import { cn } from '@/lib/utils'
import type { PanZoomSize } from '../../../../shared/pan-zoom-view'
import type { PanZoomViewport } from './use-pan-zoom-viewport'

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
  /** Shown instead of the image while it has no source. */
  fallback?: React.ReactNode
  onLoad?: React.ReactEventHandler<HTMLImageElement>
  onError?: React.ReactEventHandler<HTMLImageElement>
}): React.JSX.Element {
  const { setCanvas, canvasHandlers, cursor, scale, offset } = panZoom
  return (
    <div
      ref={setCanvas}
      data-testid="pan-zoom-image-canvas"
      className={cn('touch-none overflow-hidden', src && cursor && CURSOR_CLASS[cursor], className)}
      style={background ? { backgroundColor: background } : undefined}
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
            'pointer-events-none absolute top-0 left-0 max-w-none select-none',
            !offset && 'invisible'
          )}
          style={
            content && offset
              ? {
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
