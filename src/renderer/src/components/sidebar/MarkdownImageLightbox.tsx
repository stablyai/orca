import React from 'react'
import { PanZoomImageDialog } from '@/components/editor/PanZoomImageDialog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type ExpandableMarkdownImageProps = {
  src: string | undefined
  alt?: string
  className?: string
  triggerClassName?: string
  onError?: () => void
  onLoad?: React.ReactEventHandler<HTMLImageElement>
  open?: boolean
  onOpenChange?: (open: boolean) => void
  triggerLabel?: string
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  onAuxClick?: React.MouseEventHandler<HTMLButtonElement>
  triggerAttributes?: Record<`data-${string}`, string | undefined>
  triggerRef?: React.Ref<HTMLButtonElement>
  triggerStyle?: React.CSSProperties
  dialogProps?: Omit<
    React.ComponentProps<typeof PanZoomImageDialog>,
    'open' | 'onOpenChange' | 'src' | 'title' | 'showTitle'
  >
}

/** Delegate lightbox focus, Escape and focus restoration to the shared pan/zoom dialog. */
export function ExpandableMarkdownImage({
  src,
  alt,
  className,
  triggerClassName,
  onError,
  onLoad,
  open: controlledOpen,
  onOpenChange,
  triggerLabel,
  onClick,
  onAuxClick,
  triggerAttributes,
  triggerRef,
  triggerStyle,
  dialogProps
}: ExpandableMarkdownImageProps): React.JSX.Element {
  const [internalOpen, setInternalOpen] = React.useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = (nextOpen: boolean): void => {
    if (controlledOpen === undefined) {
      setInternalOpen(nextOpen)
    }
    onOpenChange?.(nextOpen)
  }
  const label =
    alt?.trim() || translate('auto.components.sidebar.MarkdownImageLightbox.image', 'Image')

  return (
    <>
      <button
        ref={triggerRef}
        style={triggerStyle}
        type="button"
        {...triggerAttributes}
        className={cn(
          'my-3 block max-w-full cursor-zoom-in border-0 bg-transparent p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          triggerClassName
        )}
        onClick={(event) => {
          event.stopPropagation()
          onClick?.(event)
          if (!event.defaultPrevented) {
            event.preventDefault()
            setOpen(true)
          }
        }}
        onAuxClick={onAuxClick}
        aria-label={
          triggerLabel ??
          translate('auto.components.sidebar.MarkdownImageLightbox.expand', 'Expand image')
        }
      >
        {src ? (
          <img
            src={src}
            alt={alt ?? ''}
            className={cn(className, 'pointer-events-none')}
            onError={onError}
            onLoad={onLoad}
          />
        ) : (
          <span className="text-sm text-muted-foreground">{label}</span>
        )}
      </button>
      <PanZoomImageDialog
        {...dialogProps}
        open={open}
        onOpenChange={setOpen}
        src={src}
        title={label}
        showTitle
      />
    </>
  )
}
