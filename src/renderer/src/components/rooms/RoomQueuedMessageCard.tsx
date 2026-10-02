import { useEffect, useState } from 'react'
import { buildImageDataUri } from '../../../../shared/image-data-uri'
import type { RoomMessage } from '../../../../shared/rooms'
import {
  SortableQueuedMessageCard,
  type QueuedMessageCardProps,
  type QueuedMessageItem
} from '../native-chat/QueuedMessageCard'
import { readRoomAttachmentPreview } from './room-attachment-transfer'
import type { RoomData } from './use-room-data'

/** Shared queue row: the common 1:1 card plus room attachment previews. */
export function RoomQueuedMessageCard({
  data,
  message,
  item,
  ...props
}: Omit<QueuedMessageCardProps, 'item'> & {
  data: RoomData
  message: RoomMessage
  item: QueuedMessageItem
}): React.JSX.Element {
  const [images, setImages] = useState<NonNullable<QueuedMessageItem['images']>>([])
  useEffect(() => {
    let active = true
    setImages([])
    const attachments = message.attachments.filter(({ mimeType }) => mimeType.startsWith('image/'))
    void Promise.all(
      attachments.map(async (attachment) => {
        const preview = await readRoomAttachmentPreview(data.target, message.roomId, {
          id: attachment.id
        })
        const url = preview ? buildImageDataUri(preview.mimeType, preview.contentBase64) : null
        return url ? [{ id: attachment.id, fileName: attachment.fileName, url }] : []
      })
    )
      .catch(() => [])
      .then((loaded) => {
        if (active) {
          setImages(loaded.flat())
        }
      })
    return () => {
      active = false
    }
  }, [data.target, message.attachments, message.roomId])
  return (
    <SortableQueuedMessageCard
      {...props}
      item={{ ...item, images }}
      canSteer={props.canSteer ?? item.canSteer}
      dragDisabled={props.dragDisabled ?? item.dragDisabled}
      hideWhileDragging
    />
  )
}
