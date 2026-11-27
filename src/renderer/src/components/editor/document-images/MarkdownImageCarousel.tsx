import { Fragment, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { MarkdownCarouselImage } from './markdown-image-carousel'
import {
  markdownImageCarouselExports,
  type MarkdownCarouselImageContext
} from './markdown-image-carousel-export'

export function MarkdownImageCarousel({
  images,
  imageContext,
  renderImage,
  'data-source-line': sourceLine,
  'data-source-end-line': sourceEndLine
}: {
  images: [MarkdownCarouselImage, ...MarkdownCarouselImage[]]
  imageContext: MarkdownCarouselImageContext
  renderImage: (image: MarkdownCarouselImage, className: string) => ReactNode
  'data-source-line'?: number
  'data-source-end-line'?: number
}): React.JSX.Element {
  const t = useTranslate()
  const [index, setIndex] = useState(0)
  const active = index % images.length
  const image = images[active] ?? images[0]

  return (
    <div
      ref={(element) => {
        if (element) {
          markdownImageCarouselExports.set(element, { images, imageContext })
        }
      }}
      data-orca-image-carousel="true"
      role="group"
      aria-label={t('auto.components.editor.MarkdownImageCarousel.label', 'Image carousel')}
      data-source-line={sourceLine}
      data-source-end-line={sourceEndLine}
      className="my-3 flex min-w-0 flex-col items-center gap-2 rounded-md border border-border p-3"
    >
      <Fragment key={image.src}>
        {renderImage(image, 'block max-h-80 w-auto max-w-full object-contain')}
      </Fragment>
      {images.length > 1 && (
        <div className="flex items-center gap-2" data-orca-export-hide="true">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('auto.components.editor.PanZoomImageDialog.previous', 'Previous image')}
            onClick={() => setIndex((active + images.length - 1) % images.length)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <span aria-live="polite" className="text-xs text-muted-foreground tabular-nums">
            {active + 1} / {images.length}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('auto.components.editor.PanZoomImageDialog.next', 'Next image')}
            onClick={() => setIndex((active + 1) % images.length)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  )
}
