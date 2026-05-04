import { Image as ImageIcon, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { type JSX, useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import PdfViewer from './PdfViewer'

const FALLBACK_IMAGE_MIME_TYPE = 'image/png'
const MIN_ZOOM = 0.25
const MAX_ZOOM = 8
const ZOOM_STEP = 1.25

type ImageViewerProps = {
  content: string
  filePath: string
  mimeType?: string
}

export default function ImageViewer({
  content,
  filePath,
  mimeType = FALLBACK_IMAGE_MIME_TYPE
}: ImageViewerProps): JSX.Element {
  const [imageError, setImageError] = useState(false)
  const [isPopupOpen, setIsPopupOpen] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(
    null
  )

  const filename = useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath])
  const cleanedContent = useMemo(() => content.replace(/\s/g, ''), [content])
  const isPdf = mimeType === 'application/pdf'
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
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
  const zoomPercent = Math.round(zoom * 100)

  useEffect(() => {
    setImageError(false)
    if (!cleanedContent || isPdf) {
      setPreviewUrl(null)
      return
    }
    let binary: string
    try {
      binary = window.atob(cleanedContent)
    } catch {
      setImageError(true)
      return
    }
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
    setPreviewUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [cleanedContent, mimeType, isPdf])

  if (isPdf) {
    return <PdfViewer content={cleanedContent} filePath={filePath} />
  }

  if (imageError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted/20 p-8 text-sm text-muted-foreground">
        <ImageIcon size={40} />
        <div>Failed to load file preview</div>
        <div className="max-w-md break-all text-center text-xs">{filename}</div>
      </div>
    )
  }

  if (!previewUrl) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading preview...
      </div>
    )
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        <div
          className="flex flex-1 items-center justify-center overflow-auto bg-muted/20 p-4 cursor-pointer"
          onClick={() => setIsPopupOpen(true)}
          title="Open image in popup"
        >
          <div
            className="flex items-center justify-center"
            style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
          >
            <img
              src={previewUrl}
              alt={filename}
              className="max-h-full max-w-full object-contain"
              onLoad={(event) => {
                const img = event.currentTarget
                setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight })
              }}
              onError={() => setImageError(true)}
            />
          </div>
        </div>
        <div className="flex items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
              onClick={() => setZoom((prev) => Math.max(MIN_ZOOM, prev / ZOOM_STEP))}
              disabled={zoom <= MIN_ZOOM}
              title="Zoom out"
            >
              <ZoomOut size={14} />
            </button>
            <button
              type="button"
              className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
              onClick={() => setZoom(1)}
              disabled={zoom === 1}
              title="Reset zoom"
            >
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
              onClick={() => setZoom((prev) => Math.min(MAX_ZOOM, prev * ZOOM_STEP))}
              disabled={zoom >= MAX_ZOOM}
              title="Zoom in"
            >
              <ZoomIn size={14} />
            </button>
            <span className="ml-1 tabular-nums">{zoomPercent}%</span>
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
      <Dialog open={isPopupOpen} onOpenChange={setIsPopupOpen}>
        <DialogContent
          showCloseButton={false}
          className="top-1/2 left-1/2 h-[80vh] w-[70vw] max-w-[70vw] -translate-x-1/2 -translate-y-1/2 gap-0 overflow-hidden border border-border/60 bg-background p-0 shadow-2xl sm:max-w-[70vw]"
        >
          <DialogTitle className="sr-only">{filename}</DialogTitle>
          <DialogDescription className="sr-only">Full-size image preview</DialogDescription>
          <div className="flex items-center justify-between border-b border-border/60 bg-background/95 px-3 py-2">
            <div className="min-w-0 truncate text-sm font-medium text-foreground">{filename}</div>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setIsPopupOpen(false)}
            >
              <X size={14} />
              <span>Close</span>
            </button>
          </div>
          <div className="flex h-[calc(100%-4.5rem)] w-full min-h-0 items-center justify-center overflow-auto bg-muted/20 p-4">
            <div
              className="flex items-center justify-center"
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
            >
              <img
                src={previewUrl}
                alt={filename}
                className="block max-h-full max-w-full object-contain"
              />
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-border/60 bg-background/95 px-3 py-2 text-xs text-muted-foreground">
            <div>Press Esc to close</div>
            <div className="tabular-nums">{zoomPercent}%</div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
