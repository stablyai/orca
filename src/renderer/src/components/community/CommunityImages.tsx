import { useState } from 'react'
import { ChevronLeft, ChevronRight, Expand, ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PanZoomImageDialog } from '@/components/editor/PanZoomImageDialog'
import { useTranslate } from '@/i18n/use-translate'
export function CommunityImages({
  images,
  title
}: {
  images: string[]
  title: string
}): React.JSX.Element {
  const t = useTranslate()
  const [selected, setSelected] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const index = Math.min(selected, Math.max(0, images.length - 1))
  const change = (step: number): void => setSelected((index + step + images.length) % images.length)
  return (
    <section aria-label={t('community.imagePreview', 'Proposal images')} className="space-y-3">
      <div className="relative flex h-96 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/30 max-sm:h-64">
        {images[index] ? (
          <button
            className="size-full p-4 focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
            onClick={() => setExpanded(true)}
            aria-label={t('community.expand', 'Expand image')}
          >
            <img
              src={images[index]}
              alt={`${title} · ${index + 1}`}
              referrerPolicy="no-referrer"
              className="size-full object-contain"
            />
          </button>
        ) : (
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <ImageIcon className="size-8" />
            <p className="text-sm">
              {t('community.noImages', 'The author has not linked an image.')}
            </p>
          </div>
        )}
        {images.length > 0 && (
          <Button
            variant="outline"
            size="icon-sm"
            className="absolute top-3 right-3"
            onClick={() => setExpanded(true)}
            aria-label={t('community.expand', 'Expand image')}
          >
            <Expand className="size-4" />
          </Button>
        )}
        {images.length > 1 && (
          <div className="pointer-events-none absolute inset-x-3 top-1/2 flex justify-between">
            <Button
              variant="outline"
              size="icon-sm"
              className="pointer-events-auto"
              onClick={() => change(-1)}
              aria-label={t('community.previousImage', 'Previous image')}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              className="pointer-events-auto"
              onClick={() => change(1)}
              aria-label={t('community.nextImage', 'Next image')}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        )}
      </div>
      {images.length > 1 && (
        <div className="scrollbar-sleek flex justify-center gap-2 overflow-x-auto p-1">
          {images.map((src, i) => (
            <button
              key={src}
              type="button"
              className="size-16 shrink-0 overflow-hidden rounded-md border border-border bg-muted opacity-60 aria-pressed:opacity-100 aria-pressed:ring-2 aria-pressed:ring-ring focus-visible:ring-2 focus-visible:ring-ring"
              aria-pressed={i === index}
              aria-label={`${t('community.image', 'Image')} ${i + 1}`}
              onClick={() => setSelected(i)}
            >
              <img
                src={src}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="size-full object-contain"
              />
            </button>
          ))}
        </div>
      )}
      <p className="text-2xs text-muted-foreground">
        {t(
          'community.imageSource',
          'Images are linked by the PR author. They do not prove that a build passed checks.'
        )}
      </p>
      <PanZoomImageDialog
        open={expanded}
        onOpenChange={setExpanded}
        src={images[index]}
        title={title}
        showTitle
        gallery={images.map((src, i) => ({ id: src, src, title: `${title} · ${i + 1}` }))}
        selectedIndex={index}
        onSelectImage={setSelected}
      />
    </section>
  )
}
