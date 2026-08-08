import { useEffect, useRef, useState } from 'react'
import { Paperclip, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type { RoomDelivery, RoomMessage } from '../../../../shared/rooms'
import type { RoomData } from './use-room-data'
import { RoomDictationButton } from './RoomDictationButton'
import {
  cancelRoomAttachmentUpload,
  type PendingRoomAttachment,
  uploadRoomAttachment
} from './room-attachment-transfer'
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
  const [attachments, setAttachments] = useState<PendingRoomAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([])
  const [cursor, setCursor] = useState(0)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [suggestionsOpen, setSuggestionsOpen] = useState(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
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
    setAttachments([])
    setSelectedRecipients([])
    return () => {
      roomIdRef.current = null
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
        const uploaded = await uploadRoomAttachment(data.target, roomId, file, (done, total) =>
          setUploadProgress(total > 0 ? Math.round((done / total) * 100) : 100)
        )
        if (roomIdRef.current !== roomId) {
          await cancelRoomAttachmentUpload(data.target, uploaded.uploadId)
          continue
        }
        setAttachments((current) => [...current, uploaded])
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
      setUploadProgress(null)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  return (
    <div className="shrink-0 border-t border-border bg-background px-4 pb-4 pt-2">
      <div
        className="mx-auto max-w-4xl rounded-lg border border-border bg-muted/30 p-1.5 shadow-xs"
        aria-busy={uploading}
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
        {attachments.length > 0 ? (
          <div className="mb-1 flex flex-wrap gap-1">
            {attachments.map((attachment) => (
              <span
                key={attachment.uploadId}
                className="inline-flex max-w-48 items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
              >
                <span className="truncate">{attachment.fileName}</span>
                <button
                  type="button"
                  aria-label={translate('rooms.composer.removeAttachment', 'Remove attachment')}
                  onClick={() => {
                    setAttachments((current) =>
                      current.filter((item) => item.uploadId !== attachment.uploadId)
                    )
                    void cancelRoomAttachmentUpload(data.target, attachment.uploadId)
                  }}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {uploading ? (
          <div className="mb-1 px-2 text-[11px] text-muted-foreground">
            {uploadProgress === null
              ? translate('rooms.composer.uploading', 'Uploading attachment…')
              : translate('rooms.composer.uploadProgress', 'Uploading attachment… {{percent}}%', {
                  percent: uploadProgress
                })}
          </div>
        ) : null}
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
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length === 0) {
              return
            }
            event.preventDefault()
            void attach(files)
          }}
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
