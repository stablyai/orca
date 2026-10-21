import React from 'react'
import { PanZoomImageDialog } from '@/components/editor/PanZoomImageDialog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type ExpandableMarkdownImageProps = {
  src: string
  alt?: string
  className?: string
  triggerClassName?: string
  onError?: () => void
}

/**
 * Inline markdown image that opens a viewport-centered lightbox on click.
 * The shared pan and zoom dialog owns modal focus, Escape, and focus restoration.
 */
export function ExpandableMarkdownImage({
  src,
  alt,
  className,
  triggerClassName,
  onError
}: ExpandableMarkdownImageProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const label =
    alt?.trim() || translate('auto.components.sidebar.MarkdownImageLightbox.image', 'Image')

  return (
    <>
      <button
        type="button"
        className={cn(
          'my-3 block max-w-full cursor-zoom-in border-0 bg-transparent p-0 text-left',
          triggerClassName
        )}
        onClick={(event) => {
          // Why: prevent parent row/card handlers from treating the zoom click
          // as selection/navigation.
          event.stopPropagation()
          setOpen(true)
        }}
        aria-label={translate(
          'auto.components.sidebar.MarkdownImageLightbox.expand',
          'Expand image'
        )}
      >
        <img
          src={src}
          alt={alt ?? ''}
          className={cn(className, 'pointer-events-none')}
          onError={onError}
        />
      </button>
      <PanZoomImageDialog open={open} onOpenChange={setOpen} src={src} title={label} showTitle />
    </>
  )
}
