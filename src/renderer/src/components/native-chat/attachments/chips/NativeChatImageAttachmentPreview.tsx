import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Image as ImageIcon, ImageOff, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { basename } from '@/lib/path'
import { useLocalImageSrc } from '@/components/editor/document-images/useLocalImageSrc'
import { NativeChatMediaViewer } from '../../media/notes/NativeChatMediaViewer'
import { useNativeChatAttachmentNotes } from '../../media/notes/native-chat-attachment-notes'
import {
  markNativeChatNotedImageEditing,
  replaceNativeChatNotedImage,
  restoreNativeChatCleanImage,
  takeNativeChatNotedImage,
  useNativeChatNotesOriginal
} from '../../media/notes/native-chat-chip-notes'
import {
  dismissNativeChatNotesNoticeFor,
  showNativeChatNotesNotice
} from '../../media/notes/native-chat-notes-notice'
import { nativeChatNotesImageName } from '../../media/notes/native-chat-media-notes'
import {
  nativeChatNotesMediaKey,
  useNativeChatHeldNotesCount
} from '../../media/notes/native-chat-held-notes'
import {
  copyableNativeChatImageSrc,
  keepPreviewOpenForChatMenu
} from '../../media/images/native-chat-image-copy'
import { isAgentInlineImagePath } from '../../../../../../shared/native-chat/input/composer/agent-inline-image-types'
import { isNativeChatPastedImagePath } from '../../../../../../shared/native-chat/attachments/native-chat-image-label'
import type { NativeChatComposerImageAttachment } from './native-chat-image-attachment'
import { isAgentSessionAttachmentStorePath } from '../../../../../../shared/agent-session/agent-session-attachments'
import { chatImageAccess } from '@/lib/files/access/local-file-access'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import { nativeChatImageNumberLabel } from '../../composer/editor/NativeChatImageReferencePill'

type Props = {
  attachment: NativeChatComposerImageAttachment
  /** Structured-chat image position, shared by prompt chips and send markers. */
  number?: number
  /** The paired server the chat runs on; a file stored there is read back through it. */
  hostEnvironmentId?: string
  /** The draft holding this chip, whose marked images keep their notes. */
  notesScopeKey?: string
  onRemove: (id: string) => void
}

export function NativeChatImageAttachmentPreview({
  attachment,
  hostEnvironmentId,
  notesScopeKey,
  number,
  onRemove
}: Props): React.JSX.Element {
  if (attachment.unavailableName !== undefined) {
    return (
      <NativeChatUnavailableImageChip
        id={attachment.id}
        name={attachment.unavailableName}
        number={number}
        onRemove={onRemove}
      />
    )
  }
  return (
    <NativeChatImageThumbnail
      attachment={attachment}
      hostEnvironmentId={hostEnvironmentId}
      notesScopeKey={notesScopeKey}
      number={number}
      onRemove={onRemove}
    />
  )
}

function ImageNumberBadge({ number }: { number?: number }): React.JSX.Element | null {
  if (number === undefined) {
    return null
  }
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute bottom-0.5 left-0.5 rounded-full bg-background/85 px-1 text-3xs font-medium text-foreground tabular-nums"
    >
      #{number}
    </span>
  )
}

function numberedLabel(number: number | undefined, label: string, t?: Translate): string {
  return number === undefined ? label : `${nativeChatImageNumberLabel(number, t)}: ${label}`
}

function attachmentLabel(path: string, t: Translate = translate): string {
  return isNativeChatPastedImagePath(path)
    ? t('components.native-chat.composer.pastedImageLabel', 'Pasted image')
    : basename(path)
}

function RemoveAttachmentButton({ onRemove }: { onRemove: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={t('components.native-chat.composer.removeAttachment', 'Remove attachment')}
      className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border border-border bg-chat-canvas text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <X className="size-3" />
    </button>
  )
}

/** Missing files can be reattached; a new paste cannot recover a missing pasted image, so offer removal only. */
function NativeChatUnavailableImageChip({
  id,
  name,
  number,
  onRemove
}: {
  id: string
  name: string
  number?: number
  onRemove: (id: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const pasted = isNativeChatPastedImagePath(name)
  const label = attachmentLabel(name, t)
  const explanation = pasted
    ? t(
        'components.native-chat.composer.pastedImageNotBroughtBack',
        "This pasted image couldn't be brought back with this draft. Remove it, and paste it again if you still need it."
      )
    : t(
        'components.native-chat.composer.imageNotBroughtBack',
        "{{name}} couldn't be brought back with this draft. Attach it again or remove it.",
        { name: label }
      )
  const hint = pasted
    ? t('components.native-chat.composer.pastedImageNotKeptLabel', 'Not kept')
    : t('components.native-chat.composer.imageAttachAgainLabel', 'Attach again')
  return (
    <div className="relative h-14 max-w-40 shrink-0">
      <div
        role="img"
        aria-label={numberedLabel(number, explanation, t)}
        title={explanation}
        className="flex h-full items-center gap-2 rounded-md border border-dashed border-border bg-background px-2"
      >
        <ImageOff className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-col text-xs">
          <span className="truncate text-foreground">{label}</span>
          <span className="truncate text-muted-foreground">{hint}</span>
        </div>
        <ImageNumberBadge number={number} />
      </div>
      <RemoveAttachmentButton onRemove={() => onRemove(id)} />
    </div>
  )
}

function NativeChatImageThumbnail({
  attachment,
  hostEnvironmentId,
  notesScopeKey,
  number,
  onRemove
}: Props): React.JSX.Element {
  const t = useTranslate()
  const [isOpen, setIsOpen] = useState(false)
  // A marked image's notes reopen editable on the media they were made on.
  const notes = useNativeChatAttachmentNotes(notesScopeKey ?? '', attachment.id)
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
            target: runtimeTargetForOwnerEnvironment(readEnvironmentId),
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
  // Use the immediate clipboard preview for thumbnails and prefer the stored file for full-size viewing.
  const thumbnailSrc = attachment.previewUrl ?? localSrc
  const fullSizeSrc = localSrc ?? attachment.previewUrl
  // Reopened, a marked image is edited on its clean original; the viewer waits until that is read.
  const original = useNativeChatNotesOriginal(notes, isOpen, hostReadContext)
  // A marked image is named for the media its notes are on, not as a generic pasted image.
  const filename = notes
    ? nativeChatNotesImageName(notes.mediaName, undefined)
    : attachmentLabel(attachment.path, t)
  const pendingLabel = attachment.pendingName
    ? t('components.native-chat.composer.uploadingFile', 'Uploading {{name}}…', {
        name: attachment.pendingName
      })
    : t('components.native-chat.composer.imageSaving', 'Saving pasted image…')
  const label = isPending ? (attachment.pendingName ?? pendingLabel) : filename
  // A dropped document uploads as a chip too, and becomes an `@` reference once stored.
  const isFile =
    attachment.pendingName !== undefined && !isAgentInlineImagePath(attachment.pendingName)
  const KindIcon = isFile ? FileText : ImageIcon
  // The thumbnail may be the downscaled clipboard preview; copy only the file.
  const copySrc = copyableNativeChatImageSrc(localSrc)
  // Notes kept for this image while the message box held a command mark it too.
  const plainSource = {
    path: attachment.path,
    ...(attachment.connectionId ? { connectionId: attachment.connectionId } : {})
  }
  const keptCount = useNativeChatHeldNotesCount(
    notesScopeKey,
    attachment.path ? nativeChatNotesMediaKey(plainSource) : undefined
  )
  const notesLabel = notes
    ? t('components.native-chat.notes.chipCount', '{{count}} notes', {
        defaultValue_one: '{{count}} note',
        count: notes.notes.length
      })
    : keptCount > 0
      ? t('components.native-chat.notes.kept', 'Notes kept')
      : null
  // Reopened in the viewer: these notes are being edited and are replaced when it closes.
  const editing = isOpen && notes !== null
  useEffect(() => {
    if (!editing || !notesScopeKey) {
      return undefined
    }
    // Reopened, the group is no longer the one its "added" line can undo, and it sits out Send.
    dismissNativeChatNotesNoticeFor(notesScopeKey, attachment.id)
    return markNativeChatNotedImageEditing(notesScopeKey, attachment.id)
  }, [attachment.id, editing, notesScopeKey])
  const remove = (): void => {
    if (!notes || !notesScopeKey) {
      onRemove(attachment.id)
      return
    }
    const putBack = takeNativeChatNotedImage(notesScopeKey, attachment.id)
    showNativeChatNotesNotice(notesScopeKey, {
      text: t('components.native-chat.notes.notesRemoved', '{{count}} notes removed', {
        defaultValue_one: '{{count}} note removed',
        count: notes.notes.length
      }),
      undo: putBack
    })
  }

  return (
    <>
      <div ref={thumbnailRef} className="relative size-14 shrink-0">
        <button
          type="button"
          aria-label={numberedLabel(
            number,
            isPending
              ? pendingLabel
              : `${t('components.native-chat.composer.viewAttachment', 'View image')}: ${label}${notesLabel ? `, ${notesLabel}` : ''}`,
            t
          )}
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
              className={`size-full object-cover${isPending || editing ? ' opacity-50' : ''}`}
            />
          ) : isPending ? (
            <span className="flex max-w-full flex-col items-center gap-1 px-1">
              <LoadingSpinner className="size-4 shrink-0 text-muted-foreground" />
              {attachment.pendingName ? (
                <span className="max-w-full truncate text-xs text-muted-foreground">
                  {attachment.pendingName}
                </span>
              ) : null}
            </span>
          ) : (
            <KindIcon className="size-5 text-muted-foreground" />
          )}
        </button>
        {isPending && thumbnailSrc ? (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center rounded-b-md bg-chat-canvas/90 py-0.5">
            <LoadingSpinner className="size-3 text-muted-foreground" />
          </span>
        ) : null}
        <ImageNumberBadge number={number} />
        {notesLabel ? (
          <span
            title={notesLabel}
            className="pointer-events-none absolute inset-x-0.5 bottom-0.5 truncate rounded bg-background/90 px-1 text-center text-2xs font-medium text-foreground tabular-nums"
          >
            {editing ? t('components.native-chat.notes.editing', 'Editing…') : notesLabel}
          </span>
        ) : null}
        <RemoveAttachmentButton onRemove={remove} />
      </div>
      <NativeChatMediaViewer
        open={isOpen && (!notes || Boolean(original.src) || original.failed)}
        onOpenChange={setIsOpen}
        key={notes ? (original.src ? 'original' : 'marked') : 'plain'}
        src={(notes ? original.src : null) ?? fullSizeSrc ?? null}
        title={notes?.mediaName ?? label}
        source={notes?.source ?? plainSource}
        opener={thumbnailRef}
        initialNotes={notes && original.src ? notes.notes : undefined}
        // Numbering goes on from the copy these notes were first drawn on.
        offset={notes?.offset}
        // Without its clean original a marked image can only be viewed: new marks would land on old ones.
        annotatable={!notes || Boolean(original.src)}
        replacesAttachmentId={attachment.id}
        // The marked image takes this chip's place; Undo puts this chip and its notes back.
        onAttached={
          notesScopeKey
            ? () => replaceNativeChatNotedImage(notesScopeKey, attachment.id)
            : undefined
        }
        onCleared={
          notes && notesScopeKey
            ? () => restoreNativeChatCleanImage(notesScopeKey, attachment.id, notes)
            : undefined
        }
        onInteractOutside={keepPreviewOpenForChatMenu}
        copySrc={copySrc}
        fallback={
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {isPending ? (
              <>
                <LoadingSpinner className="size-4" />
                {pendingLabel}
              </>
            ) : (
              <>
                <ImageIcon className="size-4" />
                {t(
                  'components.native-chat.composer.imagePreviewUnavailable',
                  'Preview unavailable'
                )}
              </>
            )}
          </div>
        }
      />
    </>
  )
}
