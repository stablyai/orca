import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Image as ImageIcon, ImageOff, Loader2, X } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import { useLocalImageSrc } from '@/components/editor/useLocalImageSrc'
import { copyableNativeChatImageSrc, keepPreviewOpenForChatMenu } from './native-chat-image-copy'
import {
  isNativeChatImageAttachmentPath,
  isNativeChatPastedImagePath
} from './native-chat-image-paste'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { isAgentSessionAttachmentStorePath } from '../../../../shared/agent-session-attachments'
import { chatImageAccess } from '@/lib/local-file-access'

type Props = {
  attachment: NativeChatComposerImageAttachment
  /** The paired server the chat runs on; a file stored there is read back through it. */
  hostEnvironmentId?: string
  onRemove: (id: string) => void
}

/** Thumbnail for a pending image, with an in-app full-size preview on click. */
export function NativeChatImageAttachmentPreview({
  attachment,
  hostEnvironmentId,
  onRemove
}: Props): React.JSX.Element {
  if (attachment.unavailableName !== undefined) {
    return (
      <NativeChatUnavailableImageChip
        id={attachment.id}
        name={attachment.unavailableName}
        onRemove={onRemove}
      />
    )
  }
  return (
    <NativeChatImageThumbnail
      attachment={attachment}
      hostEnvironmentId={hostEnvironmentId}
      onRemove={onRemove}
    />
  )
}

function attachmentLabel(path: string): string {
  return isNativeChatPastedImagePath(path)
    ? translate('components.native-chat.composer.pastedImageLabel', 'Pasted image')
    : basename(path)
}

function RemoveAttachmentButton({ onRemove }: { onRemove: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={translate(
        'components.native-chat.composer.removeAttachment',
        'Remove attachment'
      )}
      className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border border-border bg-chat-canvas text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <X className="size-3" />
    </button>
  )
}

/** An image the draft names but couldn't bring back. A file can be attached again in its place; a
 *  pasted image can't be matched by a new paste, so its copy asks only for removal. */
function NativeChatUnavailableImageChip({
  id,
  name,
  onRemove
}: {
  id: string
  name: string
  onRemove: (id: string) => void
}): React.JSX.Element {
  const pasted = isNativeChatPastedImagePath(name)
  const label = attachmentLabel(name)
  const explanation = pasted
    ? translate(
        'components.native-chat.composer.pastedImageNotBroughtBack',
        "This pasted image couldn't be brought back with this draft. Remove it, and paste it again if you still need it."
      )
    : translate(
        'components.native-chat.composer.imageNotBroughtBack',
        "{{name}} couldn't be brought back with this draft. Attach it again or remove it.",
        { name: label }
      )
  const hint = pasted
    ? translate('components.native-chat.composer.pastedImageNotKeptLabel', 'Not kept')
    : translate('components.native-chat.composer.imageAttachAgainLabel', 'Attach again')
  return (
    <div className="relative h-14 max-w-40 shrink-0">
      <div
        role="img"
        aria-label={explanation}
        title={explanation}
        className="flex h-full items-center gap-2 rounded-md border border-dashed border-border bg-background px-2"
      >
        <ImageOff className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-col text-xs">
          <span className="truncate text-foreground">{label}</span>
          <span className="truncate text-muted-foreground">{hint}</span>
        </div>
      </div>
      <RemoveAttachmentButton onRemove={() => onRemove(id)} />
    </div>
  )
}

function NativeChatImageThumbnail({
  attachment,
  hostEnvironmentId,
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
  // A stored attachment is a path on the paired server, read back through that server.
  const readEnvironmentId =
    hostEnvironmentId && isAgentSessionAttachmentStorePath(attachment.path)
      ? hostEnvironmentId
      : undefined
  const hostReadContext = useMemo(
    () =>
      readEnvironmentId
        ? {
            settings: { activeRuntimeEnvironmentId: readEnvironmentId },
            worktreeId: null,
            worktreePath: null
          }
        : undefined,
    [readEnvironmentId]
  )
  const localSrc = useLocalImageSrc(
    !isPending && (isNearViewport || isOpen) ? attachment.path : undefined,
    attachment.path,
    attachment.connectionId,
    hostReadContext,
    // Why chat-image: a draft handed off from the host queue may carry paths a paired client chose.
    chatImageAccess()
  )
  // The clipboard thumbnail is already in this process, so it renders with no
  // round-trip; the on-disk file only wins for the full-size dialog.
  const thumbnailSrc = attachment.previewUrl ?? localSrc
  const fullSizeSrc = localSrc ?? attachment.previewUrl
  const filename = attachmentLabel(attachment.path)
  const pendingLabel = attachment.pendingName
    ? translate('components.native-chat.composer.uploadingFile', 'Uploading {{name}}…', {
        name: attachment.pendingName
      })
    : translate('components.native-chat.composer.imageSaving', 'Saving pasted image…')
  const label = isPending ? (attachment.pendingName ?? pendingLabel) : filename
  // A dropped document uploads as a chip too, and becomes an `@` reference once stored.
  const isFile =
    attachment.pendingName !== undefined && !isNativeChatImageAttachmentPath(attachment.pendingName)
  const KindIcon = isFile ? FileText : ImageIcon
  // The thumbnail may be the downscaled clipboard preview; copy only the file.
  const copySrc = copyableNativeChatImageSrc(localSrc)

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
          data-native-chat-copy-image-src={copySrc}
          onClick={() => setIsOpen(true)}
          className="flex size-full items-center justify-center overflow-hidden rounded-md border border-border bg-chat-canvas transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {thumbnailSrc ? (
            <img
              src={thumbnailSrc}
              alt={label}
              className={`size-full object-cover${isPending ? ' opacity-50' : ''}`}
            />
          ) : attachment.pendingName ? (
            <span className="flex max-w-full flex-col items-center gap-0.5 px-1">
              <KindIcon className="size-5 shrink-0 text-muted-foreground" />
              <span className="max-w-full truncate text-xs text-muted-foreground">
                {attachment.pendingName}
              </span>
            </span>
          ) : (
            <KindIcon className="size-5 text-muted-foreground" />
          )}
        </button>
        {isPending ? (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-chat-canvas/50">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </span>
        ) : null}
        <RemoveAttachmentButton onRemove={() => onRemove(attachment.id)} />
      </div>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent
          onInteractOutside={keepPreviewOpenForChatMenu}
          className="flex max-h-[90vh] max-w-[90vw] flex-col sm:max-w-4xl"
        >
          <DialogTitle className="truncate text-sm">{label}</DialogTitle>
          <DialogDescription className="sr-only">
            {translate('components.native-chat.composer.imagePreview', 'Full-size image preview')}
          </DialogDescription>
          <div className="scrollbar-sleek flex min-h-0 items-center justify-center overflow-auto rounded-md bg-muted/20 p-2">
            {fullSizeSrc ? (
              <img
                src={fullSizeSrc}
                alt={label}
                data-native-chat-copy-image-src={copySrc}
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
