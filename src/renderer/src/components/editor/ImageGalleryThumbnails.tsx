import { useEffect, useRef } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { ImageGalleryItem } from './ImageGalleryGrid'

export function ImageGalleryThumbnails({
  images,
  selectedIndex,
  onSelect
}: {
  images: ImageGalleryItem[]
  selectedIndex: number
  onSelect: (index: number) => void
}): React.JSX.Element {
  const t = useTranslate()
  const strip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    strip.current
      ?.querySelector('[aria-pressed="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedIndex])
  return (
    <div
      className="flex shrink-0 items-center gap-3 border-t border-border bg-background p-3"
      aria-label={t('components.imageGallery.images', 'Images')}
    >
      <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground" aria-live="polite">
        {t('components.imageGallery.position', '{{current}} of {{total}}', {
          current: selectedIndex + 1,
          total: images.length
        })}
      </span>
      <div ref={strip} className="flex min-w-0 flex-1 gap-2 overflow-x-auto p-1 scrollbar-sleek">
        {images.map((image, index) => (
          <button
            key={image.id}
            type="button"
            aria-label={image.title}
            aria-pressed={index === selectedIndex}
            onClick={() => onSelect(index)}
            className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-muted-foreground opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:opacity-100 aria-pressed:ring-2 aria-pressed:ring-ring"
          >
            {image.src ? (
              <img
                src={image.src}
                alt={image.title}
                loading="lazy"
                className="size-full object-contain"
              />
            ) : (
              <span className="truncate text-xs">{image.title}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
