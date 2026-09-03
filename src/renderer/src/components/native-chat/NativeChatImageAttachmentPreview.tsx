import { useEffect, useRef, useState } from 'react'
import { Image as ImageIcon, Loader2, X } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import { useLocalImageSrc } from '@/components/editor/useLocalImageSrc'
import { isNativeChatPastedImagePath } from './native-chat-image-paste'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

type Props = {
  attachment: NativeChatComposerImageAttachment
  onRemove: (id: string) => void
}

/** Thumbnail for a pending image, with an in-app full-size preview on click. */
export function NativeChatImageAttachmentPreview({
  attachment,
  onRemove
}: Props): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [isNearViewport, setIsNearViewport] = useState(false)
  const thumbnailRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = thumbnailRef.current
    if (!element) {
      return
    }
    if (typeof IntersectionObserver === 'undefined') {
      setIsNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsNearViewport(true)
          observer.disconnect()
        }
      },
      { rootMargin: '128px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const isPending = attachment.pending === true
  const localSrc = useLocalImageSrc(
    !isPending && (isNearViewport || isOpen) ? attachment.path : undefined,
    attachment.path,
    attachment.connectionId
  )
  // The clipboard thumbnail is already in this process, so it renders with no
  // round-trip; the on-disk file only wins for the full-size dialog.
  const thumbnailSrc = attachment.previewUrl ?? localSrc
  const fullSizeSrc = localSrc ?? attachment.previewUrl
  const filename = isNativeChatPastedImagePath(attachment.path)
    ? translate('components.native-chat.composer.pastedImageLabel', 'Pasted image')
    : basename(attachment.path)
  const pendingLabel = translate(
    'components.native-chat.composer.imageSaving',
    'Saving pasted image…'
  )
  const label = isPending ? pendingLabel : filename

  return (
    <>
      <div ref={thumbnailRef} className="relative size-14 shrink-0">
        <button
          type="button"
          aria-label={
            isPending
              ? pendingLabel
              : `${translate('components.native-chat.composer.viewAttachment', 'View image')}: ${label}`
          }
          aria-busy={isPending}
          title={label}
          onClick={() => setIsOpen(true)}
          className="flex size-full items-center justify-center overflow-hidden rounded-md border border-border bg-background transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {thumbnailSrc ? (
            <img
              src={thumbnailSrc}
              alt={label}
              className={`size-full object-cover${isPending ? ' opacity-50' : ''}`}
            />
          ) : (
            <ImageIcon className="size-5 text-muted-foreground" />
          )}
        </button>
        {isPending ? (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-background/50">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => onRemove(attachment.id)}
          aria-label={translate(
            'components.native-chat.composer.removeAttachment',
            'Remove attachment'
          )}
          className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3" />
        </button>
      </div>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-[90vw] flex-col gap-3 border-border bg-background p-3 sm:max-w-4xl">
          <DialogTitle className="truncate text-sm">{label}</DialogTitle>
          <DialogDescription className="sr-only">
            {translate('components.native-chat.composer.imagePreview', 'Full-size image preview')}
          </DialogDescription>
          <div className="scrollbar-sleek flex min-h-0 items-center justify-center overflow-auto rounded-md bg-muted/20 p-2">
            {fullSizeSrc ? (
              <img
                src={fullSizeSrc}
                alt={label}
                className="max-h-[75vh] max-w-full object-contain"
              />
            ) : (
              <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
                {isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {pendingLabel}
                  </>
                ) : (
                  <>
                    <ImageIcon className="size-4" />
                    {translate(
                      'components.native-chat.composer.imagePreviewUnavailable',
                      'Preview unavailable'
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
