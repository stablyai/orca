import { Image as ImageIcon, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { type JSX, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import ImageViewerPopup from './ImageViewerPopup'
import { EditorCommandOwnerContext } from './editor-command-owner-context'
import { listenForViewerZoomRequests } from './viewer-zoom-request'
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
import { translate } from '@/i18n/i18n'
import { buildImageDataUri } from '../../../../shared/image-data-uri'

const FALLBACK_IMAGE_MIME_TYPE = 'image/png'

type ImageViewerProps = {
  /** Base64 bytes, for git blobs, diffs and the web client. */
  content?: string
  /** An orca-media URL the image or PDF is read from by range; wins over `content`. */
  src?: string
  /** The file's size when `src` hides the bytes. */
  byteSize?: number
  filePath: string
  mimeType?: string
  layout?: 'fill' | 'intrinsic'
  // Persist zoom only with owner-qualified identity; diff/conflict callers must not use a path-only key.
  preferenceKey?: string | null
  // Omission disables PDF scroll memory because diff/conflict surfaces can share a path.
  scrollCacheKey?: string | null
}

export default function ImageViewer({
  content = '',
  src,
  byteSize,
  filePath,
  mimeType = FALLBACK_IMAGE_MIME_TYPE,
  layout = 'fill',
  preferenceKey,
  scrollCacheKey = null
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
  const isCommandOwner = useContext(EditorCommandOwnerContext)

  const filename = useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath])
  const cleanedContent = useMemo(() => content.replace(/\s/g, ''), [content])
  // A remint changes only the URL's revision; keep zoom unless the grant or the file's size changed.
  const srcIdentity = src ? src.split('?')[0] : undefined
  const imageStateKey = useMemo(
    () =>
      `${filePath}\n${mimeType}\n${srcIdentity !== undefined ? `${srcIdentity}\n${byteSize ?? ''}` : cleanedContent}`,
    [filePath, mimeType, srcIdentity, byteSize, cleanedContent]
  )
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
    () =>
      src && mimeType.startsWith('image/') ? src : buildImageDataUri(mimeType, cleanedContent),
    [cleanedContent, mimeType, src]
  )
  const imageError =
    (previewSrc === null && cleanedContent.length > 0) ||
    (previewSrc !== null && failedPreviewSrc === previewSrc)
  const estimatedSize = useMemo(() => {
    if (src && byteSize === undefined) {
      return ''
    }
    const bytes = byteSize ?? Math.floor((cleanedContent.length * 3) / 4)
    if (bytes < 1024) {
      return `${bytes} B`
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }, [byteSize, cleanedContent, src])
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
        // Chromium reports pinch as ctrl-wheel; a non-passive listener must cancel browser zoom.
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

  useEffect(() => {
    // Why: PDFs own their zoom; combined diff images yield to editor text until a popup opens.
    if (!isCommandOwner || isPdf || (isIntrinsicLayout && !isPopupOpen)) {
      return
    }
    const applyZoomChange = isPopupOpen ? applyPopupZoomChange : applyInlineZoomChange
    return listenForViewerZoomRequests(
      (direction) =>
        applyZoomChange((currentZoom) => {
          if (direction === 'reset') {
            return 1
          }
          return direction === 'in'
            ? currentZoom * IMAGE_VIEWER_ZOOM_STEP
            : currentZoom / IMAGE_VIEWER_ZOOM_STEP
        }),
      isPopupOpen ? popupSurfaceRef : inlineSurfaceRef,
      isPopupOpen ? 'popup' : 'pane'
    )
  }, [
    applyInlineZoomChange,
    applyPopupZoomChange,
    isCommandOwner,
    isIntrinsicLayout,
    isPdf,
    isPopupOpen
  ])

  if (isPdf) {
    return (
      <PdfViewer
        content={cleanedContent}
        src={src}
        byteSize={byteSize}
        filePath={filePath}
        preferenceKey={preferenceKey}
        scrollCacheKey={scrollCacheKey}
      />
    )
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
        <div>
          {translate(
            'auto.components.editor.ImageViewer.d9d2944855',
            'Failed to load file preview'
          )}
        </div>
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
        {translate('auto.components.editor.ImageViewer.3ef9551ba2', 'Loading preview...')}
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
          title={translate('auto.components.editor.ImageViewer.77bfc9b35a', 'Open image in popup')}
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
                      : // Percentage maxima cannot constrain the w-max/h-max box before load; use viewport units.
                        'block max-h-[100vh] max-w-[100vw]'
                )}
                onLoad={(event) => {
                  const img = event.currentTarget
                  setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight })
                  setFailedPreviewSrc(null)
                }}
                // Key failures by source so new images retry immediately without an effect reset.
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
              title={translate('auto.components.editor.ImageViewer.be27304574', 'Zoom out')}
            >
              <ZoomOut size={14} />
            </button>
            <button
              type="button"
              className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
              onClick={() => applyInlineZoomChange(() => 1)}
              disabled={inlineZoom === 1}
              title={translate('auto.components.editor.ImageViewer.6c89c73d9f', 'Reset zoom')}
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
              title={translate('auto.components.editor.ImageViewer.3c9217f5a6', 'Zoom in')}
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
