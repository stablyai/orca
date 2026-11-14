import React, { useState } from 'react'
import { Copy, Maximize, X, ZoomIn, ZoomOut } from 'lucide-react'
import { toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import {
  clipboardImageCopyErrorDescription,
  imageCopyFailedMessage
} from '@/lib/clipboard/images/clipboard-image-copy'
import type { PanZoomSize } from '../../../../shared/pan-zoom-view'
import { IMAGE_VIEWER_ZOOM_STEP } from './image-viewer-zoom'
import { imageClipboardPngDataUrl } from './image-png-export'
import { PanZoomImageSurface } from './PanZoomImageSurface'
import { usePanZoomViewport } from './use-pan-zoom-viewport'
import { useViewerZoomCommands } from './use-viewer-zoom-commands'
import { ImageViewerToolbarButton } from './ImageViewerToolbarButton'

async function copyImageAsPng(
  src: string,
  size: PanZoomSize,
  background: string | undefined
): Promise<void> {
  try {
    await window.api.ui.writeClipboardImage(
      await imageClipboardPngDataUrl(src, size, background ?? null)
    )
    toast.success(translate('auto.components.editor.PanZoomImageDialog.copiedPng', 'Copied as PNG'))
  } catch (error) {
    toast.error(imageCopyFailedMessage(), {
      description: clipboardImageCopyErrorDescription(error)
    })
  }
}

export function PanZoomImageCanvas({
  src,
  size,
  title,
  showTitle,
  background,
  fallback,
  toolbarActions,
  onClose
}: {
  src: string | null | undefined
  size?: PanZoomSize | null
  title: string
  showTitle?: boolean
  background?: string
  fallback?: React.ReactNode
  toolbarActions?: React.ReactNode
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [loaded, setLoaded] = useState<{ src: string; size: PanZoomSize } | null>(null)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const imageSrc = src && src !== failedSrc ? src : null
  const content = size ?? (loaded && loaded.src === imageSrc ? loaded.size : null)
  const panZoom = usePanZoomViewport({ content })
  useViewerZoomCommands(panZoom, 'popup')

  return (
    <>
      {/* Anchor to dialog edges so padding cannot frame the canvas. */}
      <PanZoomImageSurface
        panZoom={panZoom}
        src={imageSrc}
        alt={title}
        content={content}
        className="absolute inset-0 bg-background"
        background={background}
        fallback={fallback}
        onLoad={(event) => {
          const { naturalWidth: width, naturalHeight: height } = event.currentTarget
          if (imageSrc && width > 0 && height > 0) {
            setLoaded({ src: imageSrc, size: { width, height } })
          }
        }}
        onError={() => setFailedSrc(imageSrc)}
      />
      {/* These dialogs can open outside the app tooltip provider. */}
      <TooltipProvider>
        <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start gap-3">
          {showTitle ? (
            <span
              aria-hidden
              className="min-w-0 truncate rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground shadow-xs"
            >
              {title}
            </span>
          ) : null}
          <div className="pointer-events-auto ml-auto flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-xs">
            <ImageViewerToolbarButton
              label={t('auto.components.editor.PanZoomImageDialog.zoomOut', 'Zoom out')}
              disabled={!panZoom.canZoomOut}
              onClick={() => panZoom.zoomBy(1 / IMAGE_VIEWER_ZOOM_STEP)}
            >
              <ZoomOut />
            </ImageViewerToolbarButton>
            <ImageViewerToolbarButton
              label={t('auto.components.editor.PanZoomImageDialog.zoomIn', 'Zoom in')}
              disabled={!panZoom.canZoomIn}
              onClick={() => panZoom.zoomBy(IMAGE_VIEWER_ZOOM_STEP)}
            >
              <ZoomIn />
            </ImageViewerToolbarButton>
            <ImageViewerToolbarButton
              label={t('auto.components.editor.PanZoomImageDialog.fit', 'Fit to screen')}
              disabled={panZoom.isFitted}
              onClick={panZoom.fit}
            >
              <Maximize />
            </ImageViewerToolbarButton>
            <ImageViewerToolbarButton
              label={t('auto.components.editor.PanZoomImageDialog.copyPng', 'Copy as PNG')}
              disabled={!imageSrc || !content}
              onClick={() =>
                imageSrc && content && void copyImageAsPng(imageSrc, content, background)
              }
            >
              <Copy />
            </ImageViewerToolbarButton>
            {toolbarActions}
            <ImageViewerToolbarButton
              label={t('auto.components.editor.PanZoomImageDialog.close', 'Close')}
              onClick={onClose}
            >
              <X />
            </ImageViewerToolbarButton>
          </div>
        </div>
      </TooltipProvider>
    </>
  )
}
