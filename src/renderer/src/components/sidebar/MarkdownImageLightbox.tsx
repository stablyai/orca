import React from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { beginMarkdownImageLightbox } from './markdown-image-lightbox-state'

type ExpandableMarkdownImageProps = {
  src: string
  alt?: string
  className?: string
}

type MarkdownImageLightboxOverlayProps = {
  src: string
  alt: string
  onClose: () => void
}

function MarkdownImageLightboxOverlay({
  src,
  alt,
  onClose
}: MarkdownImageLightboxOverlayProps): React.JSX.Element {
  const closeButtonRef = React.useRef<HTMLButtonElement>(null)
  const closedRef = React.useRef(false)

  const requestClose = React.useCallback(
    (event?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
      event?.preventDefault?.()
      event?.stopPropagation?.()
      if (closedRef.current) {
        return
      }
      closedRef.current = true
      // Why: unmounting this portal on the same click/pointer that hit the close
      // control can fall through to the Sheet dismiss layer underneath and close
      // the whole issue drawer. Defer one tick so the event finishes first.
      window.setTimeout(() => {
        onClose()
      }, 0)
    },
    [onClose]
  )

  React.useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    // Why: Sheets register Escape/outside-dismiss handlers; this global flag
    // lets SheetContent no-op those while the lightbox owns the viewport.
    const endLightbox = beginMarkdownImageLightbox()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      // Why: also stopImmediatePropagation so any later/earlier bubble listeners
      // on the same target do not close the parent drawer after we handle Esc.
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      requestClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      endLightbox()
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [requestClose])

  const swallowPointer = (event: React.SyntheticEvent): void => {
    event.preventDefault()
    event.stopPropagation()
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      // Why: issue drawers/sheets sit at z-50; paint above the full app so the
      // enlarged image is centered on the viewport, not the drawer.
      // Radix disables body pointer events while the parent Sheet is modal, so
      // this nested portal must opt back in or its visible controls cannot click.
      className="pointer-events-auto fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4 backdrop-blur-[3px]"
      onPointerDown={swallowPointer}
      onMouseDown={swallowPointer}
      onClick={(event) => requestClose(event)}
    >
      <div className="relative inline-flex max-h-[90vh] max-w-[calc(100vw-2rem)] items-start gap-4">
        <button
          ref={closeButtonRef}
          type="button"
          className="order-2 z-10 inline-flex size-10 shrink-0 -translate-y-3 items-center justify-center rounded-full border border-white/20 bg-black/55 text-white shadow-md backdrop-blur-sm transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          onPointerDown={(event) => requestClose(event)}
          onMouseDown={swallowPointer}
          onClick={(event) => requestClose(event)}
          aria-label={translate('auto.components.sidebar.MarkdownImageLightbox.close', 'Close')}
        >
          <X className="size-5" />
        </button>
        <img
          src={src}
          alt={alt}
          className="max-h-[90vh] max-w-[min(calc(100vw-5rem),1200px)] rounded-md object-contain shadow-2xl"
          onPointerDown={swallowPointer}
          onMouseDown={swallowPointer}
          onClick={swallowPointer}
        />
      </div>
    </div>,
    document.body
  )
}

/**
 * Inline markdown image that opens a viewport-centered lightbox on click.
 * Portals above sheets/drawers so the preview is not confined to the panel.
 */
export function ExpandableMarkdownImage({
  src,
  alt,
  className
}: ExpandableMarkdownImageProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const label =
    alt?.trim() || translate('auto.components.sidebar.MarkdownImageLightbox.image', 'Image')

  return (
    <>
      <button
        type="button"
        className="my-3 block max-w-full cursor-zoom-in border-0 bg-transparent p-0 text-left"
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
        <img src={src} alt={alt ?? ''} className={cn(className, 'pointer-events-none')} />
      </button>

      {open ? (
        <MarkdownImageLightboxOverlay src={src} alt={label} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}
