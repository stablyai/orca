import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { RoomData } from './use-room-data'
import { RoomComposerActions } from './RoomComposerActions'
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
import { useRoomComposerWorkControl } from './use-room-composer-work-control'
import { ComposerPromptTextarea } from '@/components/ComposerPromptTextarea'
import { RoomComposerQueueTargets } from './RoomComposerQueueTargets'
import { showRoomActionError } from './room-action-error'
import type { RoomQueueComposerEdit } from './room-queue-composer-edit'
import { useRoomQueueComposerEdit } from './use-room-queue-composer-edit'
import {
  applyRoomComposerSuggestion,
  getExactRoomMentionSuggestion,
  getRoomComposerQuery,
  getRoomComposerSuggestions,
  RoomComposerSuggestions,
  type RoomComposerSuggestion
} from './RoomComposerSuggestions'
import { submitRoomComposer } from './submit-room-composer'

const NOOP = (): void => {}

export function RoomComposer({
  data,
  editing = null,
  onEditComplete = NOOP
}: {
  data: RoomData
  editing?: RoomQueueComposerEdit | null
  onEditComplete?: () => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<RoomComposerAttachment[]>([])
  const [uploadingAttachment, setUploadingAttachment] = useState<UploadingRoomAttachment | null>(
    null
  )
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
  const [targetParticipantIds, setTargetParticipantIds] = useState<string[] | null>(null)
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
  const supportsDeliveryQueue = data.snapshot?.deliveryQueueVersion === 1
  const composerQuery = suggestionsOpen ? getRoomComposerQuery(text, cursor) : null
  const suggestions = getRoomComposerSuggestions(composerQuery, data.snapshot?.participants ?? [])
  const selectSuggestion = (suggestion: RoomComposerSuggestion): void => {
    if (!composerQuery) {
      return
    }
    const next = applyRoomComposerSuggestion(text, composerQuery, suggestion.value)
    setText(next.text)
    if (composerQuery.kind === 'mention' && !editing) {
      if (suggestion.identity === 'all') {
        setTargetParticipantIds(null)
      } else if (suggestion.participant) {
        setTargetParticipantIds((current) =>
          current === null
            ? [suggestion.participant!.id]
            : [...new Set([...current, suggestion.participant!.id])]
        )
      }
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
    setTargetParticipantIds(null)
    return () => {
      roomIdRef.current = null
      uploadAbortRef.current?.abort()
      releaseRoomAttachmentPreviews(attachmentsRef.current)
      releaseRoomAttachmentPreview(uploadingAttachmentRef.current?.previewUrl ?? null)
      for (const attachment of attachmentsRef.current) {
        if (attachment.source === 'upload') {
          void cancelRoomAttachmentUpload(data.target, attachment.uploadId)
        }
      }
    }
  }, [data.roomId, data.target])

  useRoomQueueComposerEdit({
    data,
    editing,
    onEditComplete,
    textareaRef,
    attachmentsRef,
    setText,
    setTargetParticipantIds,
    setAttachments
  })

  const send = async (): Promise<void> => {
    if (!data.roomId || (!text.trim() && attachments.length === 0) || sending || uploading) {
      return
    }
    setSending(true)
    try {
      const submitted = await submitRoomComposer({
        data,
        text,
        attachments,
        editing,
        targetParticipantIds
      })
      if (!submitted) {
        return
      }
      releaseRoomAttachmentPreviews(attachments)
      setText('')
      setTargetParticipantIds(null)
      setAttachments([])
      if (editing) {
        onEditComplete()
      }
    } catch (error) {
      if (!editing) {
        await Promise.all(
          attachments.flatMap((attachment) =>
            attachment.source === 'upload'
              ? [cancelRoomAttachmentUpload(data.target, attachment.uploadId)]
              : []
          )
        )
        releaseRoomAttachmentPreviews(attachments)
        setAttachments([])
      }
      showRoomActionError(error)
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
            { ...uploaded, source: 'upload', mimeType: file.type, previewUrl }
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

  const hasDraft = Boolean(text.trim()) || attachments.length > 0 || uploading
  const workControl = useRoomComposerWorkControl({
    data,
    hasDraft,
    sending,
    sendDisabled: (!text.trim() && attachments.length === 0) || uploading,
    send
  })

  return (
    <div className="shrink-0 bg-background px-4 pb-4 pt-2">
      <div className="relative isolate mx-auto max-w-4xl">
        <RoomComposerSuggestions
          suggestions={suggestions}
          activeIndex={Math.min(activeSuggestion, Math.max(0, suggestions.length - 1))}
          onSelect={selectSuggestion}
        />
      </div>
      <div
        ref={composerRootRef}
        className="relative z-10 mx-auto max-w-4xl rounded-lg border border-border bg-[color-mix(in_srgb,var(--muted)_30%,var(--background))] p-1.5 shadow-xs"
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
        {supportsDeliveryQueue ? (
          <RoomComposerQueueTargets
            participants={data.snapshot?.participants ?? []}
            value={targetParticipantIds}
            onChange={setTargetParticipantIds}
            disabled={Boolean(editing)}
          />
        ) : null}
        <RoomComposerAttachments
          attachments={attachments}
          uploading={uploadingAttachment}
          onCancelUpload={() => uploadAbortRef.current?.abort()}
          onRemove={(attachment) => {
            setAttachments((current) => current.filter((item) => item !== attachment))
            releaseRoomAttachmentPreview(attachment.previewUrl)
            if (attachment.source === 'upload') {
              void cancelRoomAttachmentUpload(data.target, attachment.uploadId)
            }
          }}
        />
        <ComposerPromptTextarea
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
          placeholder={translate(
            'rooms.composer.placeholder',
            'Message the room — use @agent to invite a response'
          )}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => void attach(Array.from(event.target.files ?? []))}
        />
        <RoomComposerActions
          attachDisabled={uploading || attachments.length >= 10}
          onAttach={() => fileInputRef.current?.click()}
          textareaRef={textareaRef}
          run={{
            mode: editing ? 'send' : workControl.mode,
            label: editing ? translate('rooms.common.send', 'Send') : workControl.label,
            disabled: editing
              ? sending || uploading || (!text.trim() && attachments.length === 0)
              : workControl.disabled,
            loading: !editing && workControl.loading,
            invoke: () => void (editing ? send() : workControl.run())
          }}
        />
      </div>
    </div>
  )
}
