import { ChevronLeft, ChevronRight, Download, Minus, Plus, X } from 'lucide-react'
import { DialogClose } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'

export type ImagePreview = {
  fileName: string
  src: string
  onDownload: () => void
  onPrevious?: () => void
  onNext?: () => void
}

const FLOATING_BUTTON_CLASS =
  'pointer-events-auto flex size-10 items-center justify-center rounded-full border border-border/50 bg-popover/95 text-popover-foreground shadow-md backdrop-blur-sm transition-colors hover:bg-accent hover:text-accent-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40'
const ZOOM_BUTTON_CLASS =
  'pointer-events-auto flex size-9 items-center justify-center rounded-full transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40'

export function ImagePreviewControls({
  preview,
  zoomPercent,
  canZoomOut,
  canZoomIn,
  onZoomOut,
  onZoomIn,
  onReset
}: {
  preview: ImagePreview
  zoomPercent: number
  canZoomOut: boolean
  canZoomIn: boolean
  onZoomOut: () => void
  onZoomIn: () => void
  onReset: () => void
}): React.JSX.Element {
  return (
    <>
      <div className="pointer-events-none absolute top-3 right-3 z-20 flex gap-2">
        <button
          type="button"
          className={FLOATING_BUTTON_CLASS}
          onClick={preview.onDownload}
          aria-label={translate('rooms.attachment.download', 'Download')}
        >
          <Download className="size-4" />
        </button>
        <DialogClose asChild>
          <button
            type="button"
            className={FLOATING_BUTTON_CLASS}
            aria-label={translate('auto.components.ui.dialog.f26c4baeda', 'Close')}
          >
            <X className="size-4" />
          </button>
        </DialogClose>
      </div>
      {preview.onPrevious ? (
        <button
          type="button"
          className={`${FLOATING_BUTTON_CLASS} absolute top-1/2 left-3 z-20 -translate-y-1/2`}
          onClick={preview.onPrevious}
          aria-label={translate('components.imagePreview.previous', 'Previous image')}
        >
          <ChevronLeft className="size-5" />
        </button>
      ) : null}
      {preview.onNext ? (
        <button
          type="button"
          className={`${FLOATING_BUTTON_CLASS} absolute top-1/2 right-3 z-20 -translate-y-1/2`}
          onClick={preview.onNext}
          aria-label={translate('components.imagePreview.next', 'Next image')}
        >
          <ChevronRight className="size-5" />
        </button>
      ) : null}
      <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center rounded-full border border-border/50 bg-popover/95 p-1 text-popover-foreground shadow-md backdrop-blur-sm">
        <button
          type="button"
          className={ZOOM_BUTTON_CLASS}
          disabled={!canZoomOut}
          onClick={onZoomOut}
          aria-label={translate('components.imagePreview.zoomOut', 'Zoom out')}
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          className="pointer-events-auto min-w-16 rounded-full px-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onReset}
          aria-label={translate('components.imagePreview.zoomToFit', 'Zoom to fit')}
        >
          {zoomPercent}%
        </button>
        <button
          type="button"
          className={ZOOM_BUTTON_CLASS}
          disabled={!canZoomIn}
          onClick={onZoomIn}
          aria-label={translate('components.imagePreview.zoomIn', 'Zoom in')}
        >
          <Plus className="size-4" />
        </button>
      </div>
    </>
  )
}
