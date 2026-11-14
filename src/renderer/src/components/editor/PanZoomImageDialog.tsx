import React, { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, LayoutGrid } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { PanZoomSize } from '../../../../shared/pan-zoom-view'
import { PanZoomImageCanvas } from './PanZoomImageCanvas'
import { ImageViewerToolbarButton } from './ImageViewerToolbarButton'
import { ImageGalleryThumbnails } from './ImageGalleryThumbnails'
import { ImageGalleryGrid, type ImageGalleryItem } from './ImageGalleryGrid'

type PanZoomImageDialogProps = Omit<
  React.ComponentProps<typeof DialogContent>,
  'children' | 'className' | 'showCloseButton' | 'onOpenAutoFocus' | 'size'
> & {
  open: boolean
  onOpenChange: (open: boolean) => void
  src: string | null | undefined
  size?: PanZoomSize | null
  title: string
  showTitle?: boolean
  background?: string
  fallback?: React.ReactNode
  gallery?: ImageGalleryItem[]
  selectedIndex?: number
  onSelectImage?: (index: number) => void
  onGridViewChange?: (grid: boolean) => void
  onImageVisibilityChange?: (id: string, visible: boolean) => void
  getImageCopySrc?: (src: string | undefined) => string | undefined
  toolbarActions?: React.ReactNode
}

export function PanZoomImageDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  onKeyDown,
  ...props
}: PanZoomImageDialogProps): React.JSX.Element {
  const openerRef = useRef<Element | null>(null)
  const {
    src,
    size,
    title,
    showTitle,
    background,
    fallback,
    gallery,
    selectedIndex,
    onSelectImage,
    onGridViewChange,
    onImageVisibilityChange,
    toolbarActions,
    getImageCopySrc,
    ...contentProps
  } = props
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        {...contentProps}
        showCloseButton={false}
        className="h-[90dvh] w-[90vw] max-w-[90vw] overflow-hidden sm:max-w-[90vw]"
        onOpenAutoFocus={(event) => {
          openerRef.current = document.activeElement
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
          if (
            opener instanceof HTMLElement &&
            opener.isConnected &&
            useAppStore.getState().activeModal === 'none'
          ) {
            opener.focus({ preventScroll: true })
          }
        }}
      >
        <ImageViewerContents
          {...{
            src,
            size,
            title,
            showTitle,
            background,
            fallback,
            gallery,
            selectedIndex,
            onSelectImage,
            onGridViewChange,
            onImageVisibilityChange,
            toolbarActions,
            getImageCopySrc,
            onKeyDown
          }}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function ImageViewerContents({
  src,
  size,
  title,
  showTitle,
  background,
  fallback,
  gallery,
  selectedIndex = 0,
  onSelectImage,
  onGridViewChange,
  onImageVisibilityChange,
  toolbarActions,
  getImageCopySrc,
  onKeyDown,
  onClose
}: Omit<PanZoomImageDialogProps, 'open' | 'onOpenChange'> & {
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const viewer = useRef<HTMLDivElement>(null)
  const [grid, setGrid] = useState(false)
  const [thumbnailSize, setThumbnailSize] = useState(160)
  const hasGallery = !!gallery && gallery.length > 1 && !!onSelectImage
  useEffect(() => {
    onGridViewChange?.(grid)
  }, [grid, onGridViewChange])
  useEffect(() => () => onGridViewChange?.(false), [onGridViewChange])
  return (
    <div
      ref={viewer}
      tabIndex={-1}
      className="absolute inset-0 flex flex-col"
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (
          event.defaultPrevented ||
          grid ||
          !hasGallery ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        ) {
          return
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          event.stopPropagation()
          onSelectImage!(
            (selectedIndex + (event.key === 'ArrowLeft' ? -1 : 1) + gallery!.length) %
              gallery!.length
          )
        }
      }}
    >
      <DialogTitle className="sr-only">
        {grid ? t('components.imageGallery.grid', 'Image grid') : title}
      </DialogTitle>
      {grid && hasGallery ? (
        <ImageGalleryGrid
          images={gallery}
          selectedIndex={selectedIndex}
          thumbnailSize={thumbnailSize}
          onThumbnailSizeChange={setThumbnailSize}
          onSingle={() => {
            setGrid(false)
            viewer.current?.focus({ preventScroll: true })
          }}
          onSelect={(index) => {
            onSelectImage(index)
            setGrid(false)
            viewer.current?.focus({ preventScroll: true })
          }}
          onVisibilityChange={onImageVisibilityChange}
          onClose={onClose}
          getImageCopySrc={getImageCopySrc}
        />
      ) : (
        <>
          <div className="relative min-h-0 flex-1">
            <PanZoomImageCanvas
              key={src}
              {...{ src, size, title, showTitle, background, fallback, onClose }}
              toolbarActions={
                <>
                  {hasGallery && (
                    <ImageViewerToolbarButton
                      label={t('components.imageGallery.gridView', 'Grid view')}
                      onClick={() => setGrid(true)}
                    >
                      <LayoutGrid />
                    </ImageViewerToolbarButton>
                  )}
                  {toolbarActions}
                </>
              }
            />
            {hasGallery && (
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
            )}
          </div>
          {hasGallery && (
            <ImageGalleryThumbnails
              images={gallery}
              selectedIndex={selectedIndex}
              onSelect={onSelectImage}
            />
          )}
        </>
      )}
    </div>
  )
}
