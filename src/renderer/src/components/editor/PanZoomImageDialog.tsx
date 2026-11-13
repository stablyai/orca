import React, { useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Copy, Maximize, X, ZoomIn, ZoomOut } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import {
  clipboardImageCopyErrorDescription,
  imageCopyFailedMessage
} from '@/lib/clipboard/images/clipboard-image-copy'
import { IMAGE_VIEWER_ZOOM_STEP } from './image-viewer-zoom'
import { imageClipboardPngDataUrl } from './image-png-export'
import type { PanZoomSize } from '../../../../shared/pan-zoom-view'
import { PanZoomImageSurface } from './PanZoomImageSurface'
import { usePanZoomViewport } from './use-pan-zoom-viewport'
import { useViewerZoomCommands } from './use-viewer-zoom-commands'

type PanZoomImageDialogProps = Omit<
  React.ComponentProps<typeof DialogContent>,
  'children' | 'className' | 'showCloseButton' | 'onOpenAutoFocus' | 'size'
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
  gallery?: { id: string; src?: string; title: string }[]
  selectedIndex?: number
  onSelectImage?: (index: number) => void
  toolbarActions?: React.ReactNode
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
  gallery,
  selectedIndex = 0,
  onSelectImage,
  onCloseAutoFocus,
  ...contentProps
}: PanZoomImageDialogProps): React.JSX.Element {
  const t = useTranslate()
  const openerRef = useRef<Element | null>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        {...contentProps}
        onKeyDown={(event) => {
          contentProps.onKeyDown?.(event)
          if (event.defaultPrevented || !gallery || gallery.length < 2 || !onSelectImage) {
            return
          }
          if (event.altKey || event.ctrlKey || event.metaKey) {
            return
          }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            event.stopPropagation()
            onSelectImage(
              (selectedIndex + (event.key === 'ArrowLeft' ? -1 : 1) + gallery.length) %
                gallery.length
            )
          }
        }}
        showCloseButton={false}
        className="h-[90dvh] w-[90vw] max-w-[90vw] overflow-hidden sm:max-w-[90vw]"
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
        {/* Mount with dialog content so each opening starts fitted. */}
        <div className="absolute inset-0 flex flex-col">
          <div className="relative min-h-0 flex-1">
            <PanZoomImageCanvas
              key={src}
              src={src}
              size={size}
              title={title}
              showTitle={showTitle}
              background={background}
              fallback={fallback}
              toolbarActions={toolbarActions}
              onClose={() => onOpenChange(false)}
            />
            {gallery && gallery.length > 1 && onSelectImage ? (
              <div className="pointer-events-none absolute inset-x-3 top-1/2 flex justify-between">
                <Button
                  variant="outline"
                  size="icon"
                  className="pointer-events-auto"
                  aria-label={t('components.imageGallery.previous', 'Previous image')}
                  onClick={() =>
                    onSelectImage((selectedIndex - 1 + gallery.length) % gallery.length)
                  }
                >
                  <ChevronLeft />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="pointer-events-auto"
                  aria-label={t('components.imageGallery.next', 'Next image')}
                  onClick={() => onSelectImage((selectedIndex + 1) % gallery.length)}
                >
                  <ChevronRight />
                </Button>
              </div>
            ) : null}
          </div>
          {gallery && gallery.length > 1 && onSelectImage ? (
            <div
              className="scrollbar-sleek flex shrink-0 gap-2 overflow-x-auto border-t border-border bg-background p-3"
              aria-label={t('components.imageGallery.images', 'Images')}
            >
              <span
                className="self-center whitespace-nowrap text-xs text-muted-foreground"
                aria-live="polite"
              >
                {t('components.imageGallery.position', '{{current}} of {{total}}', {
                  current: selectedIndex + 1,
                  total: gallery.length
                })}
              </span>
              <div className="mx-auto flex gap-2">
                {gallery.map((image, index) => (
                  <button
                    key={image.id}
                    type="button"
                    aria-label={image.title}
                    aria-pressed={index === selectedIndex}
                    ref={(element) => {
                      if (index === selectedIndex) {
                        element?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
                      }
                    }}
                    onClick={() => onSelectImage(index)}
                    className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-muted-foreground opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:opacity-100 aria-pressed:ring-2 aria-pressed:ring-ring"
                  >
                    {image.src ? (
                      <img src={image.src} alt={image.title} className="size-full object-contain" />
                    ) : (
                      <span className="truncate text-xs">{image.title}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
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
  onClose
}: Pick<
  PanZoomImageDialogProps,
  'src' | 'size' | 'title' | 'showTitle' | 'background' | 'fallback' | 'toolbarActions'
> & { onClose: () => void }): React.JSX.Element {
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
