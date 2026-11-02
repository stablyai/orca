import { Image as ImageIcon, Maximize2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { type JSX, type SyntheticEvent, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import PdfViewer from './PdfViewer'
import { IMAGE_VIEWER_ZOOM_STEP } from './image-viewer-zoom'
import type { PanZoomSize } from '../../../../shared/pan-zoom-view'
import { PanZoomImageDialog } from './PanZoomImageDialog'
import { PanZoomImageSurface } from './PanZoomImageSurface'
import { usePanZoomViewport } from './use-pan-zoom-viewport'
import { useViewerZoomCommands } from './use-viewer-zoom-commands'
import { useSvgObjectUrl } from './use-svg-object-url'
import { translate } from '@/i18n/i18n'
import { buildImageDataUri } from '../../../../shared/image-data-uri'
import { decodeSvgBase64, readSvgIntrinsicSize } from '../../../../shared/svg-document'

const FALLBACK_IMAGE_MIME_TYPE = 'image/png'
const SVG_MIME_TYPE = 'image/svg+xml'

type ImageViewerProps = {
  /** Base64 bytes, for git blobs, diffs and the web client. */
  content?: string
  /** SVG markup, for an SVG opened as text; wins over `content` and `src`. */
  svgSource?: string
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

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function ImageViewer({
  content = '',
  svgSource,
  src,
  byteSize,
  filePath,
  mimeType = FALLBACK_IMAGE_MIME_TYPE,
  layout = 'fill',
  preferenceKey,
  scrollCacheKey = null
}: ImageViewerProps): JSX.Element {
  const [loaded, setLoaded] = useState<{ key: string | null; size: PanZoomSize } | null>(null)
  const [failedPreviewSrc, setFailedPreviewSrc] = useState<string | null>(null)

  const filename = useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath])
  const cleanedContent = useMemo(() => content.replace(/\s/g, ''), [content])
  const isPdf = mimeType === 'application/pdf'
  const svgMarkup = useMemo(
    () =>
      svgSource ??
      (mimeType === SVG_MIME_TYPE && !src && cleanedContent
        ? decodeSvgBase64(cleanedContent)
        : null),
    [cleanedContent, mimeType, src, svgSource]
  )
  const svgUrl = useSvgObjectUrl(svgMarkup)
  const svgSize = useMemo(() => (svgMarkup ? readSvgIntrinsicSize(svgMarkup) : null), [svgMarkup])
  const previewSrc = useMemo(() => {
    if (svgMarkup !== null) {
      return svgUrl
    }
    return src && mimeType.startsWith('image/') ? src : buildImageDataUri(mimeType, cleanedContent)
  }, [cleanedContent, mimeType, src, svgMarkup, svgUrl])
  const imageError =
    (previewSrc === null && svgMarkup === null && cleanedContent.length > 0) ||
    (previewSrc !== null && failedPreviewSrc === previewSrc)
  // A remint changes only the URL's revision; keep the size, and with it the zoom, across it.
  const loadedKey = src && svgMarkup === null ? src.split('?')[0] : previewSrc
  const imageSize = svgSize ?? (loaded && loaded.key === loadedKey ? loaded.size : null)
  const estimatedSize = useMemo(() => {
    if (svgMarkup !== null) {
      return formatByteSize(new Blob([svgMarkup]).size)
    }
    if (src && byteSize === undefined) {
      return ''
    }
    return formatByteSize(byteSize ?? Math.floor((cleanedContent.length * 3) / 4))
  }, [byteSize, cleanedContent, src, svgMarkup])

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

  const isIntrinsicLayout = layout === 'intrinsic'
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

  const onLoad = (event: SyntheticEvent<HTMLImageElement>): void => {
    const { naturalWidth: width, naturalHeight: height } = event.currentTarget
    if (width > 0 && height > 0) {
      setLoaded({ key: loadedKey, size: { width, height } })
    }
    setFailedPreviewSrc(null)
  }
  // Key failures by source so new images retry immediately without an effect reset.
  const onError = (): void => setFailedPreviewSrc(previewSrc)

  if (isIntrinsicLayout) {
    return (
      <IntrinsicImage
        previewSrc={previewSrc}
        filename={filename}
        imageSize={imageSize}
        onLoad={onLoad}
        onError={onError}
      />
    )
  }
  return (
    <FilledImage
      previewSrc={previewSrc}
      filename={filename}
      imageSize={imageSize}
      isVector={svgMarkup !== null}
      estimatedSize={estimatedSize}
      onLoad={onLoad}
      onError={onError}
    />
  )
}

type ImageLoadHandlers = {
  onLoad: (event: SyntheticEvent<HTMLImageElement>) => void
  onError: () => void
}

/** The editor pane's viewer: fit, click to zoom to actual size, and Alt-drag to pan. */
function FilledImage({
  previewSrc,
  filename,
  imageSize,
  isVector,
  estimatedSize,
  onLoad,
  onError
}: {
  previewSrc: string
  filename: string
  imageSize: PanZoomSize | null
  isVector: boolean
  estimatedSize: string
} & ImageLoadHandlers): JSX.Element {
  const panZoom = usePanZoomViewport({ content: imageSize, upscale: isVector, contain: true })
  useViewerZoomCommands(panZoom, 'pane')
  const zoomPercent = Math.round(panZoom.scale * 100)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <PanZoomImageSurface
          panZoom={panZoom}
          src={previewSrc}
          alt={filename}
          content={imageSize}
          className="absolute inset-0 bg-muted/20"
          onLoad={onLoad}
          onError={onError}
        />
      </div>
      <div className="flex items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
            onClick={() => panZoom.zoomBy(1 / IMAGE_VIEWER_ZOOM_STEP)}
            disabled={!panZoom.canZoomOut}
            title={translate('auto.components.editor.ImageViewer.be27304574', 'Zoom out')}
          >
            <ZoomOut size={14} />
          </button>
          <button
            type="button"
            className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
            onClick={panZoom.fit}
            disabled={panZoom.isFitted}
            title={translate('auto.components.editor.ImageViewer.fitToView', 'Fit to view')}
          >
            <RotateCcw size={14} />
          </button>
          <button
            type="button"
            className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
            onClick={() => panZoom.zoomBy(IMAGE_VIEWER_ZOOM_STEP)}
            disabled={!panZoom.canZoomIn}
            title={translate('auto.components.editor.ImageViewer.3c9217f5a6', 'Zoom in')}
          >
            <ZoomIn size={14} />
          </button>
          <button
            type="button"
            className="ml-1 rounded px-1 tabular-nums hover:bg-accent hover:text-foreground disabled:hover:bg-transparent"
            onClick={panZoom.showActualSize}
            disabled={!imageSize || zoomPercent === 100}
            title={translate('auto.components.editor.ImageViewer.actualSize', 'Actual size')}
          >
            {imageSize ? `${zoomPercent}%` : '—'}
          </button>
        </div>
        <span className="min-w-0 truncate" title={filename}>
          {filename}
        </span>
        {imageSize && (
          <span>
            {Math.round(imageSize.width)} x {Math.round(imageSize.height)}
          </span>
        )}
        <span>{estimatedSize}</span>
      </div>
    </div>
  )
}

/** An image at its own size inside a scrolling diff; expanding opens the pan and zoom viewer. */
function IntrinsicImage({
  previewSrc,
  filename,
  imageSize,
  onLoad,
  onError
}: {
  previewSrc: string
  filename: string
  imageSize: PanZoomSize | null
} & ImageLoadHandlers): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const label = translate('auto.components.editor.ImageViewer.expand', 'Expand image')
  return (
    <div className="group/image relative flex justify-center bg-muted/20 p-4">
      <img
        src={previewSrc}
        alt={filename}
        className="block h-auto max-h-none max-w-full object-contain"
        style={imageSize ? { width: imageSize.width } : undefined}
        onLoad={onLoad}
        onError={onError}
      />
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => setExpanded(true)}
        className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground transition-opacity hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none can-hover:opacity-0 can-hover:group-hover/image:opacity-100 can-hover:focus-visible:opacity-100"
      >
        <Maximize2 className="size-3.5" />
      </button>
      <PanZoomImageDialog
        open={expanded}
        onOpenChange={setExpanded}
        src={previewSrc}
        size={imageSize}
        title={filename}
        showTitle
      />
    </div>
  )
}
