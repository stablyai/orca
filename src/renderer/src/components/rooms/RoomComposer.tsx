import { useEffect, useRef, useState } from 'react'
import { Paperclip, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type { RoomDelivery, RoomMessage } from '../../../../shared/rooms'
import type { RoomData } from './use-room-data'
import { RoomDictationButton } from './RoomDictationButton'
import { cancelRoomAttachmentUpload, uploadRoomAttachment } from './room-attachment-transfer'
import {
  isPreviewableImage,
  releaseRoomAttachmentPreview,
  releaseRoomAttachmentPreviews,
  RoomComposerAttachments,
  type RoomComposerAttachment,
  type UploadingRoomAttachment
} from './RoomAttachments'
import { getRoomComposerClipboardFiles } from './room-composer-clipboard-files'
import { useRoomComposerClipboardPaste } from './room-composer-clipboard-paste'
import {
  applyRoomComposerSuggestion,
  getExactRoomMentionSuggestion,
  getRoomComposerQuery,
  getRoomComposerSuggestions,
  resolveSelectedRoomRecipients,
  RoomComposerSuggestions,
  type RoomComposerSuggestion
} from './RoomComposerSuggestions'

export function RoomComposer({
  data,
  reply,
  onReplyChange
}: {
  data: RoomData
  reply: RoomMessage | null
  onReplyChange: (message: RoomMessage | null) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<RoomComposerAttachment[]>([])
  const [uploadingAttachment, setUploadingAttachment] = useState<UploadingRoomAttachment | null>(
    null
  )
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([])
  const [cursor, setCursor] = useState(0)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [suggestionsOpen, setSuggestionsOpen] = useState(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composerRootRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  const uploadingAttachmentRef = useRef(uploadingAttachment)
  uploadingAttachmentRef.current = uploadingAttachment
  const uploadAbortRef = useRef<AbortController | null>(null)
  const roomIdRef = useRef<string | null>(null)
  const composerQuery = suggestionsOpen ? getRoomComposerQuery(text, cursor) : null
  const suggestions = getRoomComposerSuggestions(composerQuery, data.snapshot?.participants ?? [])
  const selectSuggestion = (suggestion: RoomComposerSuggestion): void => {
    if (!composerQuery) {
      return
    }
    const next = applyRoomComposerSuggestion(text, composerQuery, suggestion.value)
    setText(next.text)
    if (composerQuery.kind === 'mention') {
      setSelectedRecipients((current) => [...new Set([...current, suggestion.value])])
    }
    setCursor(next.cursor)
    setSuggestionsOpen(false)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor)
    })
  }

  useEffect(() => {
    roomIdRef.current = data.roomId
    uploadAbortRef.current?.abort()
    releaseRoomAttachmentPreviews(attachmentsRef.current)
    releaseRoomAttachmentPreview(uploadingAttachmentRef.current?.previewUrl ?? null)
    setAttachments([])
    setUploadingAttachment(null)
    setSelectedRecipients([])
    return () => {
      roomIdRef.current = null
      uploadAbortRef.current?.abort()
      releaseRoomAttachmentPreviews(attachmentsRef.current)
      releaseRoomAttachmentPreview(uploadingAttachmentRef.current?.previewUrl ?? null)
      for (const attachment of attachmentsRef.current) {
        void cancelRoomAttachmentUpload(data.target, attachment.uploadId)
      }
    }
  }, [data.roomId, data.target])

  const send = async (): Promise<void> => {
    if (!data.roomId || (!text.trim() && attachments.length === 0) || sending || uploading) {
      return
    }
    const isContinue = text.trim().toLocaleLowerCase() === '/continue' && attachments.length === 0
    const continueDeliveryIds = isContinue
      ? getRoomContinueDeliveryIds(data.messages, Object.values(data.deliveries))
      : []
    if (isContinue && continueDeliveryIds.length === 0) {
      toast.error(translate('rooms.composer.noPausedLoop', 'No paused agent loop in this room'))
      return
    }
    setSending(true)
    try {
      await (isContinue
        ? Promise.all(
            continueDeliveryIds.map((deliveryId) =>
              roomRpc(data.target, 'rooms.deliveries.retry', { deliveryId })
            )
          )
        : roomRpc(data.target, 'rooms.messages.send', {
            roomId: data.roomId,
            body: text.trim(),
            replyToId: reply?.id ?? null,
            mentions: resolveSelectedRoomRecipients(
              selectedRecipients,
              data.snapshot?.participants ?? []
            ),
            attachmentUploadIds: attachments.map((attachment) => attachment.uploadId)
          }))
      releaseRoomAttachmentPreviews(attachments)
      setText('')
      setSelectedRecipients([])
      setAttachments([])
      onReplyChange(null)
    } catch (error) {
      await Promise.all(
        attachments.map((attachment) =>
          cancelRoomAttachmentUpload(data.target, attachment.uploadId)
        )
      )
      releaseRoomAttachmentPreviews(attachments)
      setAttachments([])
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }

  const attach = async (files: File[]): Promise<void> => {
    const roomId = data.roomId
    if (!roomId || uploading || attachments.length >= 10) {
      return
    }
    setUploading(true)
    try {
      for (const file of files.slice(0, 10 - attachments.length)) {
        const previewUrl = isPreviewableImage(file.type, file.name)
          ? URL.createObjectURL(file)
          : null
        const pending: UploadingRoomAttachment = {
          id: crypto.randomUUID(),
          fileName: file.name,
          byteSize: file.size,
          mimeType: file.type,
          previewUrl,
          progress: 0
        }
        const controller = new AbortController()
        uploadAbortRef.current = controller
        uploadingAttachmentRef.current = pending
        setUploadingAttachment(pending)
        try {
          const uploaded = await uploadRoomAttachment(
            data.target,
            roomId,
            file,
            (done, total) => {
              const progress = total > 0 ? Math.round((done / total) * 100) : 100
              setUploadingAttachment((current) =>
                current?.id === pending.id ? { ...current, progress } : current
              )
            },
            controller.signal
          )
          if (roomIdRef.current !== roomId) {
            await cancelRoomAttachmentUpload(data.target, uploaded.uploadId)
            releaseRoomAttachmentPreview(previewUrl)
            continue
          }
          setAttachments((current) => [
            ...current,
            { ...uploaded, mimeType: file.type, previewUrl }
          ])
        } catch (error) {
          releaseRoomAttachmentPreview(previewUrl)
          if (!(error instanceof DOMException && error.name === 'AbortError')) {
            throw error
          }
        } finally {
          if (uploadingAttachmentRef.current?.id === pending.id) {
            uploadingAttachmentRef.current = null
            setUploadingAttachment(null)
          }
          if (uploadAbortRef.current === controller) {
            uploadAbortRef.current = null
          }
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  useRoomComposerClipboardPaste(composerRootRef, attach)

  return (
    <div className="shrink-0 border-t border-border bg-background px-4 pb-4 pt-2">
      <div
        ref={composerRootRef}
        className="mx-auto max-w-4xl rounded-lg border border-border bg-muted/30 p-1.5 shadow-xs"
        data-room-attachment-drop-target="true"
        aria-busy={uploading}
        onPasteCapture={(event) => {
          const files = getRoomComposerClipboardFiles(event.clipboardData)
          if (files.length === 0) {
            return
          }
          event.preventDefault()
          void attach(files)
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault()
          }
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length === 0) {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          void attach(Array.from(event.dataTransfer.files))
        }}
      >
        {reply ? (
          <div className="mb-1 flex items-center gap-2 rounded bg-background/70 px-2 py-1 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">
              {translate('rooms.composer.replyingTo', 'Replying to @{{identity}}: {{body}}', {
                identity: reply.senderIdentity,
                body: reply.body
              })}
            </span>
            <button
              type="button"
              onClick={() => onReplyChange(null)}
              aria-label={translate('rooms.composer.cancelReply', 'Cancel reply')}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}
        {selectedRecipients.length > 0 ? (
          <div className="mb-1 flex flex-wrap gap-1">
            {selectedRecipients.map((recipient) => (
              <span
                key={recipient}
                className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
              >
                {recipient}
                <button
                  type="button"
                  aria-label={translate('rooms.composer.removeRecipient', 'Remove {{recipient}}', {
                    recipient
                  })}
                  onClick={() =>
                    setSelectedRecipients((current) =>
                      current.filter((value) => value !== recipient)
                    )
                  }
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <RoomComposerAttachments
          attachments={attachments}
          uploading={uploadingAttachment}
          onCancelUpload={() => uploadAbortRef.current?.abort()}
          onRemove={(attachment) => {
            setAttachments((current) =>
              current.filter((item) => item.uploadId !== attachment.uploadId)
            )
            releaseRoomAttachmentPreview(attachment.previewUrl)
            void cancelRoomAttachmentUpload(data.target, attachment.uploadId)
          }}
        />
        <RoomComposerSuggestions
          suggestions={suggestions}
          activeIndex={Math.min(activeSuggestion, Math.max(0, suggestions.length - 1))}
          onSelect={selectSuggestion}
        />
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setCursor(event.target.selectionStart)
            setActiveSuggestion(0)
            setSuggestionsOpen(true)
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            const exactMention = getExactRoomMentionSuggestion(composerQuery, suggestions)
            if (event.key === ' ' && exactMention) {
              event.preventDefault()
              selectSuggestion(exactMention)
              return
            }
            if (suggestions.length > 0 && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
              event.preventDefault()
              setActiveSuggestion((current) =>
                event.key === 'ArrowDown'
                  ? (current + 1) % suggestions.length
                  : (current - 1 + suggestions.length) % suggestions.length
              )
              return
            }
            if (suggestions.length > 0 && ['Enter', 'Tab'].includes(event.key)) {
              event.preventDefault()
              selectSuggestion(suggestions[Math.min(activeSuggestion, suggestions.length - 1)]!)
              return
            }
            if (event.key === 'Escape' && suggestions.length > 0) {
              event.preventDefault()
              setSuggestionsOpen(false)
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          rows={2}
          placeholder={translate(
            'rooms.composer.placeholder',
            'Message the room — use @agent to invite a response'
          )}
          className="block max-h-48 min-h-14 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none"
        />
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || attachments.length >= 10}
            aria-label={translate('rooms.composer.attachFile', 'Attach file')}
          >
            <Paperclip className="size-4" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => void attach(Array.from(event.target.files ?? []))}
          />
          <RoomDictationButton textareaRef={textareaRef} />
          <div className="flex-1" />
          <Button
            size="icon-sm"
            onClick={() => void send()}
            disabled={(!text.trim() && attachments.length === 0) || sending || uploading}
            aria-label={translate('rooms.common.send', 'Send')}
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

export function getRoomContinueDeliveryIds(
  messages: RoomMessage[],
  deliveries: RoomDelivery[]
): string[] {
  const sequences = new Map(messages.map((message) => [message.id, message.sequence]))
  const suppressed = deliveries.filter(
    (delivery) => delivery.state === 'suppressed' && sequences.has(delivery.messageId)
  )
  const latestSequence = Math.max(
    -1,
    ...suppressed.map((delivery) => sequences.get(delivery.messageId)!)
  )
  return [
    ...new Set(
      suppressed
        .filter((delivery) => sequences.get(delivery.messageId) === latestSequence)
        .map((delivery) => delivery.id)
    )
  ]
}
