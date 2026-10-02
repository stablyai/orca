import { useEffect, useRef, useState } from 'react'
import { Image as ImageIcon, Loader2, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import { useLocalImageSrc } from '@/components/editor/useLocalImageSrc'
import { isNativeChatPastedImagePath } from './native-chat-image-paste'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { ImagePreviewDialog } from '../image-preview/ImagePreviewDialog'

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
      <ImagePreviewDialog
        preview={
          isOpen && fullSizeSrc
            ? { fileName: label, src: fullSizeSrc, onDownload: () => download(fullSizeSrc, label) }
            : null
        }
        onOpenChange={setIsOpen}
      />
    </>
  )
}

function download(src: string, fileName: string): void {
  const anchor = document.createElement('a')
  anchor.href = src
  anchor.download = fileName
  anchor.click()
}
