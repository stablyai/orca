import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ImageIcon, Minus, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { observeImageVisibility } from '@/lib/images/image-visibility'
import { listenForViewerZoomRequests } from './viewer-zoom-request'
import { ImageViewerToolbarButton } from './ImageViewerToolbarButton'

export type ImageGalleryItem = { id: string; src?: string; title: string }

export function ImageGalleryGrid({
  images,
  selectedIndex,
  thumbnailSize,
  onThumbnailSizeChange,
  onSelect,
  onSingle,
  onClose,
  onVisibilityChange,
  getImageCopySrc
}: {
  images: ImageGalleryItem[]
  selectedIndex: number
  thumbnailSize: number
  onThumbnailSizeChange: (size: number) => void
  onSelect: (index: number) => void
  onSingle: () => void
  onClose: () => void
  onVisibilityChange?: (id: string, visible: boolean) => void
  getImageCopySrc?: (src: string | undefined) => string | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const root = useRef<HTMLDivElement>(null)
  useEffect(
    () =>
      listenForViewerZoomRequests(
        (direction) => {
          onThumbnailSizeChange(
            direction === 'reset'
              ? 160
              : Math.max(80, Math.min(320, thumbnailSize + (direction === 'in' ? 32 : -32)))
          )
        },
        root,
        'popup'
      ),
    [thumbnailSize, onThumbnailSizeChange]
  )
  useEffect(() => {
    root.current?.focus({ preventScroll: true })
    root.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])
  return (
    <>
      <TooltipProvider>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-background p-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onSingle}>
              <ArrowLeft />
              {t('components.imageGallery.single', 'Single image')}
            </Button>
            <span className="text-xs text-muted-foreground">
              {t('components.imageGallery.count', '{{count}} images', { count: images.length })}
            </span>
          </div>
          <div className="order-last flex w-full items-center justify-center gap-2 sm:order-none sm:w-auto">
            <span className="text-xs text-muted-foreground">
              {t('components.imageGallery.thumbnailSize', 'Thumbnail size')}
            </span>
            <ImageViewerToolbarButton
              label={t('components.imageGallery.smaller', 'Smaller thumbnails')}
              disabled={thumbnailSize <= 80}
              onClick={() => onThumbnailSizeChange(Math.max(80, thumbnailSize - 32))}
            >
              <Minus />
            </ImageViewerToolbarButton>
            <div className="w-28">
              <Slider
                min={80}
                max={320}
                step={16}
                value={[thumbnailSize]}
                onValueChange={([size]) => onThumbnailSizeChange(size)}
                thumbLabels={[t('components.imageGallery.thumbnailSize', 'Thumbnail size')]}
                thumbValueLabels={[
                  t('components.imageGallery.gridZoomValue', '{{percent}}% grid zoom', {
                    percent: Math.round((thumbnailSize / 160) * 100)
                  })
                ]}
              />
            </div>
            <ImageViewerToolbarButton
              label={t('components.imageGallery.larger', 'Larger thumbnails')}
              disabled={thumbnailSize >= 320}
              onClick={() => onThumbnailSizeChange(Math.min(320, thumbnailSize + 32))}
            >
              <Plus />
            </ImageViewerToolbarButton>
          </div>
          <ImageViewerToolbarButton
            label={t('auto.components.editor.PanZoomImageDialog.close', 'Close')}
            onClick={onClose}
          >
            <X />
          </ImageViewerToolbarButton>
        </div>
      </TooltipProvider>
      <div
        ref={root}
        data-native-chat-copy-image-src={getImageCopySrc ? '' : undefined}
        role="region"
        aria-label={t('components.imageGallery.grid', 'Image grid')}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto bg-background p-4 scrollbar-sleek focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div
          className="grid items-start gap-3"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${thumbnailSize}px), 1fr))`
          }}
        >
          {images.map((image, index) => (
            <GridImage
              key={image.id}
              image={image}
              selected={index === selectedIndex}
              copySrc={getImageCopySrc ? (getImageCopySrc(image.src) ?? '') : undefined}
              onSelect={() => onSelect(index)}
              onVisibilityChange={onVisibilityChange}
            />
          ))}
        </div>
      </div>
    </>
  )
}

function GridImage({
  image,
  selected,
  onSelect,
  onVisibilityChange,
  copySrc
}: {
  copySrc?: string
  image: ImageGalleryItem
  selected: boolean
  onSelect: () => void
  onVisibilityChange?: (id: string, visible: boolean) => void
}): React.JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    const element = button.current
    if (!element || !onVisibilityChange) {
      return
    }
    const stop = observeImageVisibility(element, (visible) => onVisibilityChange(image.id, visible))
    return () => {
      stop()
      onVisibilityChange(image.id, false)
    }
  }, [image.id, onVisibilityChange])
  return (
    <button
      ref={button}
      data-native-chat-copy-image-src={copySrc}
      type="button"
      aria-label={image.title}
      aria-pressed={selected}
      onClick={onSelect}
      className="min-w-0 overflow-hidden rounded-md border border-border bg-muted text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-ring"
    >
      <span className="flex aspect-square items-center justify-center overflow-hidden p-2">
        {image.src && image.src !== failed ? (
          <img
            src={image.src}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="size-full object-contain"
            onError={() => setFailed(image.src ?? null)}
          />
        ) : (
          <ImageIcon className="size-6" />
        )}
      </span>
      <span className="line-clamp-2 min-h-12 border-t border-border p-2 text-xs text-foreground">
        {image.title}
      </span>
    </button>
  )
}
