import { Copy, X } from 'lucide-react'
import { type CSSProperties, type JSX, useRef } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import ImageViewerContextMenu from './ImageViewerContextMenu'
import type { ImageViewerImageDimensions } from './image-viewer-zoom'
import type { ImageViewerCopy } from './use-image-viewer-copy'
import { translate } from '@/i18n/i18n'

type ImageViewerPopupProps = ImageViewerCopy & {
  filename: string
  isOpen: boolean
  previewUrl: string
  zoomPercent: number
  imageLayoutSize: ImageViewerImageDimensions | null
  imageLayoutStyle: CSSProperties | undefined
  onOpenChange: (open: boolean) => void
  setSurfaceRef: (surface: HTMLDivElement | null) => void
}

export default function ImageViewerPopup({
  copyImage,
  copyScopeProps,
  filename,
  isOpen,
  previewUrl,
  zoomPercent,
  imageLayoutSize,
  imageLayoutStyle,
  onOpenChange,
  setSurfaceRef
}: ImageViewerPopupProps): JSX.Element {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        {...copyScopeProps}
        showCloseButton={false}
        // Why: keep Close as the default focus so Enter on open doesn't trigger the Copy button placed before it.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          closeButtonRef.current?.focus()
        }}
        className="top-1/2 left-1/2 flex h-[80vh] w-[70vw] max-w-[70vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-0 overflow-hidden border border-border/60 bg-background p-0 shadow-2xl sm:max-w-[70vw]"
      >
        <DialogTitle className="sr-only">{filename}</DialogTitle>
        <DialogDescription className="sr-only">
          {translate(
            'auto.components.editor.ImageViewerPopup.9e27b2ecaf',
            'Full-size image preview'
          )}
        </DialogDescription>
        <div className="flex shrink-0 items-center justify-between border-b border-border/60 bg-background/95 px-3 py-2">
          <div className="min-w-0 truncate text-sm font-medium text-foreground">{filename}</div>
          <div className="flex shrink-0 items-center gap-2">
            {copyImage && (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={copyImage}
              >
                <Copy size={14} />
                <span>{translate('components.native-chat.composer.copyImage', 'Copy image')}</span>
              </button>
            )}
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              ref={closeButtonRef}
              onClick={() => onOpenChange(false)}
            >
              <X size={14} />
              <span>
                {translate('auto.components.editor.ImageViewerPopup.535f4e2b56', 'Close')}
              </span>
            </button>
          </div>
        </div>
        <ImageViewerContextMenu copyImage={copyImage}>
          <div
            ref={setSurfaceRef}
            className="min-h-0 flex-1 overflow-auto bg-muted/20 scrollbar-editor"
          >
            <div className="flex h-max min-h-full w-max min-w-full items-center justify-center p-4">
              <div className="flex items-center justify-center" style={imageLayoutStyle}>
                <img
                  src={previewUrl}
                  alt={filename}
                  className={cn(
                    'object-contain',
                    imageLayoutSize
                      ? 'block h-full w-full'
                      : // Why: the w-max/h-max scroll box makes percentage maxes resolve to
                        // none, so only viewport units bound the image before onLoad.
                        'block max-h-[100vh] max-w-[100vw]'
                  )}
                />
              </div>
            </div>
          </div>
        </ImageViewerContextMenu>
        <div className="flex shrink-0 items-center justify-between border-t border-border/60 bg-background/95 px-3 py-2 text-xs text-muted-foreground">
          <div>
            {translate('auto.components.editor.ImageViewerPopup.0ef78475e7', 'Press Esc to close')}
          </div>
          <div className="tabular-nums">{zoomPercent}%</div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
