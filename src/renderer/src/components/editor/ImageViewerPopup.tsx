import { X } from 'lucide-react'
import type { CSSProperties, JSX } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { ImageViewerImageDimensions } from './image-viewer-zoom'
import { translate } from '@/i18n/i18n'

type ImageViewerPopupProps = {
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
  filename,
  isOpen,
  previewUrl,
  zoomPercent,
  imageLayoutSize,
  imageLayoutStyle,
  onOpenChange,
  setSurfaceRef
}: ImageViewerPopupProps): JSX.Element {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
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
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onOpenChange(false)}
          >
            <X size={14} />
            <span>{translate('auto.components.editor.ImageViewerPopup.535f4e2b56', 'Close')}</span>
          </button>
        </div>
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
                  imageLayoutSize ? 'block h-full w-full' : 'block max-h-full max-w-full'
                )}
              />
            </div>
          </div>
        </div>
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
