import React, { useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Copy, Maximize, X, ZoomIn, ZoomOut } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { cn } from '@/lib/class-names'
import {
  clipboardImageCopyErrorDescription,
  imageCopyFailedMessage
} from '@/lib/clipboard/images/clipboard-image-copy'
import { IMAGE_VIEWER_ZOOM_STEP } from '../viewer-viewport/image-viewer-zoom'
import { imageClipboardPngDataUrl } from './image-png-export'
import type { PanZoomSize } from '../../../../../shared/document-preview/pan-zoom-view'
import { PanZoomImageSurface } from './PanZoomImageSurface'
import { usePanZoomViewport } from '../viewer-viewport/use-pan-zoom-viewport'
import { useViewerZoomCommands } from '../viewer-viewport/use-viewer-zoom-commands'

type PanZoomImageDialogProps = Omit<
  React.ComponentProps<typeof DialogContent>,
  'children' | 'className' | 'showCloseButton' | 'onOpenAutoFocus' | 'size' | 'surface'
> & {
  open: boolean
  onOpenChange: (open: boolean) => void
  src: string | null | undefined
  /** For an image with no intrinsic size, like an SVG sized only by its viewBox; read on load otherwise. */
  size?: PanZoomSize | null
  title: string
  /** Shows the title in the corner; otherwise only screen readers hear it. */
  showTitle?: boolean
  background?: string
  /** Shown instead of the image while it has no source or after it fails to load. */
  fallback?: React.ReactNode
  toolbarActions?: React.ReactNode
  /** In a set of images: steps back or on, by the toolbar arrows or ← and →. Null at that end; both
   *  omitted for a lone image, which shows no arrows. */
  onPrevious?: (() => void) | null
  onNext?: (() => void) | null
  /** Identifies the image shown when its source can repeat: two equal URLs still start fitted. */
  imageKey?: string
  /** Beside the arrows, e.g. the set's position. */
  stepStatus?: React.ReactNode
  /** Stays mounted while images change, e.g. a live region that announces each step. */
  liveContent?: React.ReactNode
  /** Steps across a chat's images: the dialog shows its own focus and keeps room for the title. */
  gallery?: boolean
}

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

function ToolbarButton({
  label,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function PanZoomImageDialog({
  open,
  onOpenChange,
  src,
  size,
  title,
  showTitle = false,
  background,
  fallback,
  toolbarActions,
  onPrevious,
  onNext,
  imageKey,
  stepStatus,
  liveContent,
  gallery = false,
  onCloseAutoFocus,
  onKeyDown,
  busy,
  ...contentProps
}: PanZoomImageDialogProps): React.JSX.Element {
  const openerRef = useRef<Element | null>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        {...contentProps}
        busy={busy}
        onKeyDown={(event) => {
          onKeyDown?.(event)
          const step =
            event.key === 'ArrowLeft' ? onPrevious : event.key === 'ArrowRight' ? onNext : undefined
          if (
            step &&
            !event.defaultPrevented &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey
          ) {
            event.preventDefault()
            step()
          }
        }}
        showCloseButton={false}
        surface={gallery ? 'media-gallery' : 'media'}
        onOpenAutoFocus={(event) => {
          // Dialogs without triggers need an explicit opener for focus restoration.
          openerRef.current = document.activeElement
          // Toolbar focus opens a tooltip that would consume the first Escape.
          if (event.currentTarget instanceof HTMLElement) {
            event.preventDefault()
            event.currentTarget.focus()
          }
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event)
          if (event.defaultPrevented) {
            return
          }
          event.preventDefault()
          const opener = openerRef.current
          // Do not reclaim focus from a replacement modal.
          if (
            opener instanceof HTMLElement &&
            opener.isConnected &&
            useAppStore.getState().activeModal === 'none'
          ) {
            opener.focus({ preventScroll: true })
          }
        }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {/* Mount with dialog content, and again per image, so each starts fitted. */}
        <PanZoomImageCanvas
          key={imageKey ?? src ?? title}
          src={src}
          size={size}
          title={title}
          showTitle={showTitle}
          background={background}
          fallback={fallback}
          toolbarActions={toolbarActions}
          onPrevious={onPrevious}
          onNext={onNext}
          stepStatus={stepStatus}
          gallery={gallery}
          onClose={() => onOpenChange(false)}
          closeOnBackdrop={!busy}
        />
        {liveContent}
      </DialogContent>
    </Dialog>
  )
}

function PanZoomImageCanvas({
  src,
  size,
  title,
  showTitle,
  background,
  fallback,
  toolbarActions,
  onPrevious,
  onNext,
  stepStatus,
  gallery,
  onClose,
  closeOnBackdrop
}: Pick<
  PanZoomImageDialogProps,
  | 'src'
  | 'size'
  | 'title'
  | 'showTitle'
  | 'background'
  | 'fallback'
  | 'toolbarActions'
  | 'onPrevious'
  | 'onNext'
  | 'stepStatus'
  | 'gallery'
> & { onClose: () => void; closeOnBackdrop: boolean }): React.JSX.Element {
  const t = useTranslate()
  const [loaded, setLoaded] = useState<{ src: string; size: PanZoomSize } | null>(null)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const imageSrc = src && src !== failedSrc ? src : null
  const content = size ?? (loaded && loaded.src === imageSrc ? loaded.size : null)
  // Fitted images stay clear of the toolbar row above them.
  const panZoom = usePanZoomViewport({
    content,
    fitPadding: 96,
    actualSizeClickZoom: 2,
    zoomedDragPans: true,
    onClickOutsideContent: closeOnBackdrop ? onClose : undefined
  })
  useViewerZoomCommands(panZoom, 'popup')

  return (
    <>
      <PanZoomImageSurface
        panZoom={panZoom}
        src={imageSrc}
        alt={title}
        content={content}
        className="absolute inset-0"
        background={background}
        backdrop
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
        {/* Below the titlebar, clear of native window controls. */}
        <div
          className={cn(
            'pointer-events-none absolute inset-x-3 top-12 flex items-start gap-3',
            // Narrow windows move the toolbar under the title rather than squeeze the name away.
            gallery && 'flex-wrap justify-end'
          )}
        >
          {showTitle ? (
            <span
              aria-hidden
              // A hit target, so a click on the title never reaches the canvas and closes it.
              className={cn(
                'pointer-events-auto truncate rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground shadow-xs',
                gallery ? 'mr-auto min-w-[10ch]' : 'min-w-0'
              )}
            >
              {title}
            </span>
          ) : null}
          <div className="pointer-events-auto ml-auto flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-xs">
            {onPrevious !== undefined || onNext !== undefined ? (
              <>
                <ToolbarButton
                  label={t('auto.components.editor.PanZoomImageDialog.previous', 'Previous image')}
                  data-image-step="previous"
                  disabled={!onPrevious}
                  onClick={() => onPrevious?.()}
                >
                  <ChevronLeft />
                </ToolbarButton>
                <ToolbarButton
                  label={t('auto.components.editor.PanZoomImageDialog.next', 'Next image')}
                  data-image-step="next"
                  disabled={!onNext}
                  onClick={() => onNext?.()}
                >
                  <ChevronRight />
                </ToolbarButton>
                {stepStatus}
                <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
              </>
            ) : null}
            <ToolbarButton
              label={t('auto.components.editor.PanZoomImageDialog.zoomOut', 'Zoom out')}
              disabled={!panZoom.canZoomOut}
              onClick={() => panZoom.zoomBy(1 / IMAGE_VIEWER_ZOOM_STEP)}
            >
              <ZoomOut />
            </ToolbarButton>
            <ToolbarButton
              label={t('auto.components.editor.PanZoomImageDialog.zoomIn', 'Zoom in')}
              disabled={!panZoom.canZoomIn}
              onClick={() => panZoom.zoomBy(IMAGE_VIEWER_ZOOM_STEP)}
            >
              <ZoomIn />
            </ToolbarButton>
            <ToolbarButton
              label={t('auto.components.editor.PanZoomImageDialog.fit', 'Fit to screen')}
              disabled={panZoom.isFitted}
              onClick={panZoom.fit}
            >
              <Maximize />
            </ToolbarButton>
            <ToolbarButton
              label={t('auto.components.editor.PanZoomImageDialog.copyPng', 'Copy as PNG')}
              disabled={!imageSrc || !content}
              onClick={() =>
                imageSrc && content && void copyImageAsPng(imageSrc, content, background)
              }
            >
              <Copy />
            </ToolbarButton>
            {toolbarActions}
            <ToolbarButton
              label={t('auto.components.editor.PanZoomImageDialog.close', 'Close')}
              onClick={onClose}
            >
              <X />
            </ToolbarButton>
          </div>
        </div>
      </TooltipProvider>
    </>
  )
}
