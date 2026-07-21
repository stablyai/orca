import React from 'react'
import { X } from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type ExpandableMarkdownImageProps = {
  src: string
  alt?: string
  className?: string
  triggerClassName?: string
}

/**
 * Inline markdown image that opens a viewport-centered lightbox on click.
 * The shared dialog primitive owns modal focus, Escape, and focus restoration.
 */
export function ExpandableMarkdownImage({
  src,
  alt,
  className,
  triggerClassName
}: ExpandableMarkdownImageProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const label =
    alt?.trim() || translate('auto.components.sidebar.MarkdownImageLightbox.image', 'Image')

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
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
          }}
          aria-label={translate(
            'auto.components.sidebar.MarkdownImageLightbox.expand',
            'Expand image'
          )}
        >
          <img src={src} alt={alt ?? ''} className={cn(className, 'pointer-events-none')} />
        </button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        className="flex h-[90dvh] w-[90vw] max-w-[90vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[90vw]"
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{label}</span>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={translate('auto.components.sidebar.MarkdownImageLightbox.close', 'Close')}
            >
              <X className="size-4" />
            </Button>
          </DialogClose>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-4 scrollbar-editor">
          <img src={src} alt={label} className="max-h-full max-w-full rounded-md object-contain" />
        </div>
      </DialogContent>
    </Dialog>
  )
}
