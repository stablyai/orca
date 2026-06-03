/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: image surface size is measured with ResizeObserver and DOM refs, which are external layout systems outside render derivation. */
import { Image as ImageIcon, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import ImageViewerPopup from './ImageViewerPopup'
import PdfViewer from './PdfViewer'
import {
  type ApplyImageViewerZoomChange,
  applyAnchoredImageViewerZoomChange,
  applyImageSurfaceWheel,
  getElementSurfaceSize,
  getImageLayoutStyle
} from './image-viewer-dom-zoom'
import {
  IMAGE_VIEWER_ZOOM_STEP,
  MAX_IMAGE_VIEWER_ZOOM,
  MIN_IMAGE_VIEWER_ZOOM,
  type ImageViewerImageDimensions,
  type ImageViewerSurfaceSize,
  getZoomedImageLayoutSize
} from './image-viewer-zoom'

const FALLBACK_IMAGE_MIME_TYPE = 'image/png'

type ImageViewerProps = {
  content: string
  filePath: string
  mimeType?: string
  layout?: 'fill' | 'intrinsic'
}

export default function ImageViewer({
  content,
  filePath,
  mimeType = FALLBACK_IMAGE_MIME_TYPE,
  layout = 'fill'
}: ImageViewerProps): JSX.Element {
  const [isPopupOpen, setIsPopupOpen] = useState(false)
  const [inlineZoom, setInlineZoom] = useState(1)
  const [popupZoom, setPopupZoom] = useState(1)
  const inlineSurfaceRef = useRef<HTMLDivElement | null>(null)
  const popupSurfaceRef = useRef<HTMLDivElement | null>(null)
  const [inlineSurfaceSize, setInlineSurfaceSize] = useState<ImageViewerSurfaceSize | null>(null)
  const [popupSurfaceSize, setPopupSurfaceSize] = useState<ImageViewerSurfaceSize | null>(null)
  const [imageDimensions, setImageDimensions] = useState<ImageViewerImageDimensions | null>(null)
  const [failedPreviewSrc, setFailedPreviewSrc] = useState<string | null>(null)

  const filename = useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath])
  const cleanedContent = useMemo(() => content.replace(/\s/g, ''), [content])
  const imageStateKey = `${filePath}\n${mimeType}\n${cleanedContent}`
  const [lastImageStateKey, setLastImageStateKey] = useState(imageStateKey)
  if (lastImageStateKey !== imageStateKey) {
    setLastImageStateKey(imageStateKey)
    setInlineZoom(1)
    setPopupZoom(1)
    setImageDimensions(null)
  }
  const isPdf = mimeType === 'application/pdf'
  const isIntrinsicLayout = layout === 'intrinsic'
  const previewSrc = useMemo(
    () => (cleanedContent && !isPdf ? `data:${mimeType};base64,${cleanedContent}` : null),
    [cleanedContent, isPdf, mimeType]
  )
  const imageError = previewSrc !== null && failedPreviewSrc === previewSrc
  const estimatedSize = useMemo(() => {
    const bytes = Math.floor((cleanedContent.length * 3) / 4)
    if (bytes < 1024) {
      return `${bytes} B`
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }, [cleanedContent])
  const inlineZoomPercent = Math.round(inlineZoom * 100)
  const inlineImageLayoutSize = useMemo(
    () =>
      isIntrinsicLayout
        ? null
        : getZoomedImageLayoutSize({
            imageDimensions,
            surfaceSize: inlineSurfaceSize,
            zoom: inlineZoom
          }),
    [imageDimensions, inlineSurfaceSize, inlineZoom, isIntrinsicLayout]
  )
  const popupImageLayoutSize = useMemo(
    () =>
      getZoomedImageLayoutSize({
        imageDimensions,
        surfaceSize: popupSurfaceSize,
        zoom: popupZoom
      }),
    [imageDimensions, popupSurfaceSize, popupZoom]
  )
  const inlineImageLayoutStyle = useMemo(
    () => getImageLayoutStyle(inlineImageLayoutSize),
    [inlineImageLayoutSize]
  )
  const popupImageLayoutStyle = useMemo(
    () => getImageLayoutStyle(popupImageLayoutSize),
    [popupImageLayoutSize]
  )
  const applyInlineZoomChange = useCallback<ApplyImageViewerZoomChange>((getNextZoom, anchor) => {
    applyAnchoredImageViewerZoomChange(inlineSurfaceRef.current, setInlineZoom, getNextZoom, anchor)
  }, [])
  const applyPopupZoomChange = useCallback<ApplyImageViewerZoomChange>((getNextZoom, anchor) => {
    applyAnchoredImageViewerZoomChange(popupSurfaceRef.current, setPopupZoom, getNextZoom, anchor)
  }, [])
  const openPopup = useCallback(() => {
    setPopupZoom(inlineZoom)
    setIsPopupOpen(true)
  }, [inlineZoom])
  const handlePopupOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setPopupZoom(inlineZoom)
      }
      setIsPopupOpen(open)
    },
    [inlineZoom]
  )
  const handleInlineImageSurfaceWheel = useCallback(
    (event: WheelEvent) => {
      applyImageSurfaceWheel(event, applyInlineZoomChange)
    },
    [applyInlineZoomChange]
  )
  const handlePopupImageSurfaceWheel = useCallback(
    (event: WheelEvent) => {
      applyImageSurfaceWheel(event, applyPopupZoomChange)
    },
    [applyPopupZoomChange]
  )
  const setInlineSurfaceRef = useCallback(
    (surface: HTMLDivElement | null) => {
      if (inlineSurfaceRef.current) {
        inlineSurfaceRef.current.removeEventListener('wheel', handleInlineImageSurfaceWheel)
      }
      inlineSurfaceRef.current = surface
      if (surface) {
        setInlineSurfaceSize(getElementSurfaceSize(surface))
        // Why: Chromium exposes trackpad pinch as ctrl-wheel and requires a
        // native non-passive listener to stop browser/app zoom.
        surface.addEventListener('wheel', handleInlineImageSurfaceWheel, { passive: false })
      } else {
        setInlineSurfaceSize(null)
      }
    },
    [handleInlineImageSurfaceWheel]
  )
  const setPopupSurfaceRef = useCallback(
    (surface: HTMLDivElement | null) => {
      if (popupSurfaceRef.current) {
        popupSurfaceRef.current.removeEventListener('wheel', handlePopupImageSurfaceWheel)
      }
      popupSurfaceRef.current = surface
      if (surface) {
        setPopupSurfaceSize(getElementSurfaceSize(surface))
        surface.addEventListener('wheel', handlePopupImageSurfaceWheel, { passive: false })
      } else {
        setPopupSurfaceSize(null)
      }
    },
    [handlePopupImageSurfaceWheel]
  )

  useEffect(() => {
    const surface = inlineSurfaceRef.current
    if (!surface) {
      setInlineSurfaceSize(null)
      return
    }

    const updateSize = () => setInlineSurfaceSize(getElementSurfaceSize(surface))
    updateSize()
    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(updateSize)
    observer.observe(surface)
    return () => observer.disconnect()
  }, [previewSrc])

  useEffect(() => {
    if (!isPopupOpen) {
      setPopupSurfaceSize(null)
      return
    }

    const surface = popupSurfaceRef.current
    if (!surface) {
      return
    }

    const updateSize = () => setPopupSurfaceSize(getElementSurfaceSize(surface))
    updateSize()
    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(updateSize)
    observer.observe(surface)
    return () => observer.disconnect()
  }, [isPopupOpen])

  if (isPdf) {
    return <PdfViewer content={cleanedContent} filePath={filePath} />
  }

  if (imageError) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-3 bg-muted/20 p-8 text-sm text-muted-foreground',
          isIntrinsicLayout ? 'min-h-64' : 'h-full'
        )}
      >
        <ImageIcon size={40} />
        <div>Failed to load file preview</div>
        <div className="max-w-md break-all text-center text-xs">{filename}</div>
      </div>
    )
  }

  if (!previewSrc) {
    return (
      <div
        className={cn(
          'flex items-center justify-center text-muted-foreground text-sm',
          isIntrinsicLayout ? 'min-h-64' : 'h-full'
        )}
      >
        Loading preview...
      </div>
    )
  }

  return (
    <>
      <div className={cn('flex min-h-0 flex-col', isIntrinsicLayout ? 'h-auto' : 'h-full')}>
        <div
          ref={setInlineSurfaceRef}
          className={cn(
            'cursor-pointer bg-muted/20',
            isIntrinsicLayout
              ? 'flex justify-center overflow-visible p-4'
              : 'flex-1 overflow-auto scrollbar-editor'
          )}
          onClick={openPopup}
          title="Open image in popup"
        >
          <div
            className={cn(
              'flex justify-center',
              isIntrinsicLayout
                ? 'max-w-full items-start'
                : 'h-max min-h-full w-max min-w-full items-center p-4'
            )}
          >
            <div
              className="flex items-center justify-center"
              style={
                isIntrinsicLayout
                  ? { transform: `scale(${inlineZoom})`, transformOrigin: 'center center' }
                  : inlineImageLayoutStyle
              }
            >
              <img
                src={previewSrc}
                alt={filename}
                className={cn(
                  'object-contain',
                  isIntrinsicLayout
                    ? 'block h-auto max-h-none max-w-full'
                    : inlineImageLayoutSize
                      ? 'block h-full w-full'
                      : 'block max-h-full max-w-full'
                )}
                onLoad={(event) => {
                  const img = event.currentTarget
                  setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight })
                  setFailedPreviewSrc(null)
                }}
                // Why: track the failed source identity, not a boolean, so a new
                // image retries immediately without waiting for an Effect reset.
                onError={() => setFailedPreviewSrc(previewSrc)}
              />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
              onClick={() =>
                applyInlineZoomChange((currentZoom) => currentZoom / IMAGE_VIEWER_ZOOM_STEP)
              }
              disabled={inlineZoom <= MIN_IMAGE_VIEWER_ZOOM}
              title="Zoom out"
            >
              <ZoomOut size={14} />
            </button>
            <button
              type="button"
              className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
              onClick={() => applyInlineZoomChange(() => 1)}
              disabled={inlineZoom === 1}
              title="Reset zoom"
            >
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
              onClick={() =>
                applyInlineZoomChange((currentZoom) => currentZoom * IMAGE_VIEWER_ZOOM_STEP)
              }
              disabled={inlineZoom >= MAX_IMAGE_VIEWER_ZOOM}
              title="Zoom in"
            >
              <ZoomIn size={14} />
            </button>
            <span className="ml-1 tabular-nums">{inlineZoomPercent}%</span>
          </div>
          <span className="min-w-0 truncate" title={filename}>
            {filename}
          </span>
          {imageDimensions && (
            <span>
              {imageDimensions.width} x {imageDimensions.height}
            </span>
          )}
          <span>{estimatedSize}</span>
        </div>
      </div>
      <ImageViewerPopup
        filename={filename}
        imageLayoutSize={popupImageLayoutSize}
        imageLayoutStyle={popupImageLayoutStyle}
        isOpen={isPopupOpen}
        onOpenChange={handlePopupOpenChange}
        previewUrl={previewSrc}
        setSurfaceRef={setPopupSurfaceRef}
        zoomPercent={Math.round(popupZoom * 100)}
      />
    </>
  )
}
