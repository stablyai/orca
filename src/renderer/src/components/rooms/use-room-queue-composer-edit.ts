import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { buildImageDataUri } from '../../../../shared/image-data-uri'
import {
  isPreviewableImage,
  releaseRoomAttachmentPreviews,
  type RoomComposerAttachment
} from './RoomAttachments'
import { cancelRoomAttachmentUpload, readRoomAttachmentPreview } from './room-attachment-transfer'
import type { RoomQueueComposerEdit } from './room-queue-composer-edit'
import type { RoomData } from './use-room-data'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

export function useRoomQueueComposerEdit(input: {
  data: RoomData
  editing: RoomQueueComposerEdit | null
  onEditComplete: () => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  attachmentsRef: RefObject<RoomComposerAttachment[]>
  setText: Dispatch<SetStateAction<string>>
  setTargetParticipantIds: Dispatch<SetStateAction<string[] | null>>
  setAttachments: Dispatch<SetStateAction<RoomComposerAttachment[]>>
}): void {
  const {
    data,
    editing,
    onEditComplete,
    textareaRef,
    attachmentsRef,
    setText,
    setTargetParticipantIds,
    setAttachments
  } = input
  const editingRef = useRef(editing)
  editingRef.current = editing

  useEffect(
    () => () => {
      const editing = editingRef.current
      if (editing) {
        void roomRpc(data.target, 'rooms.messages.cancelQueueEdit', {
          messageId: editing.message.id,
          editToken: editing.editToken
        }).catch(() => {})
      }
    },
    [data.roomId, data.target]
  )

  useEffect(() => {
    if (!editing) {
      return
    }
    for (const attachment of attachmentsRef.current) {
      if (attachment.source === 'upload') {
        void cancelRoomAttachmentUpload(data.target, attachment.uploadId)
      }
    }
    releaseRoomAttachmentPreviews(attachmentsRef.current)
    setText(editing.message.body)
    setTargetParticipantIds(editing.targetParticipantIds)
    setAttachments(
      editing.message.attachments.map((attachment) => ({
        source: 'existing',
        attachmentId: attachment.id,
        fileName: attachment.fileName,
        byteSize: attachment.byteSize,
        mimeType: attachment.mimeType,
        previewUrl: null
      }))
    )
    const frame = requestAnimationFrame(() => textareaRef.current?.focus())
    let active = true
    void loadPreviews(data.target, editing).then((urls) => {
      if (!active || editingRef.current?.editToken !== editing.editToken) {
        return
      }
      setAttachments((current) =>
        current.map((attachment) =>
          attachment.source === 'existing' && urls.has(attachment.attachmentId)
            ? { ...attachment, previewUrl: urls.get(attachment.attachmentId)! }
            : attachment
        )
      )
    })
    return () => {
      active = false
      cancelAnimationFrame(frame)
    }
  }, [
    attachmentsRef,
    data.target,
    editing,
    setAttachments,
    setTargetParticipantIds,
    setText,
    textareaRef
  ])

  useEffect(() => {
    if (
      editing &&
      data.messages.find((message) => message.id === editing.message.id)?.queueEditing === false
    ) {
      onEditComplete()
    }
  }, [data.messages, editing, onEditComplete])
}

async function loadPreviews(
  target: RuntimeClientTarget,
  editing: RoomQueueComposerEdit
): Promise<Map<string, string>> {
  const previews = await Promise.all(
    editing.message.attachments.map(async (attachment) => {
      if (!isPreviewableImage(attachment.mimeType, attachment.fileName)) {
        return null
      }
      const preview = await readRoomAttachmentPreview(target, editing.message.roomId, {
        id: attachment.id
      })
      const url = preview ? buildImageDataUri(preview.mimeType, preview.contentBase64) : null
      return url ? ([attachment.id, url] as const) : null
    })
  ).catch(() => [])
  const result = new Map<string, string>()
  for (const preview of previews) {
    if (preview) {
      result.set(...preview)
    }
  }
  return result
}
