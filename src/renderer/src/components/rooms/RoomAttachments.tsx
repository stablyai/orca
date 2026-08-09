import { useEffect, useState } from 'react'
import { File, Image as ImageIcon, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { buildImageDataUri } from '../../../../shared/image-data-uri'
import type { RoomAttachment, RoomMessage } from '../../../../shared/rooms'
import type { RoomData } from './use-room-data'
import {
  downloadRoomAttachment,
  type PendingRoomAttachment,
  readRoomAttachmentPreview
} from './room-attachment-transfer'
import { RoomImagePreviewDialog, type RoomImagePreview } from './RoomImagePreviewDialog'

export type RoomComposerAttachment = PendingRoomAttachment & {
  mimeType: string
  previewUrl: string | null
}

export type UploadingRoomAttachment = {
  id: string
  fileName: string
  byteSize: number
  mimeType: string
  previewUrl: string | null
  progress: number
}

export function RoomComposerAttachments({
  attachments,
  uploading,
  onRemove,
  onCancelUpload
}: {
  attachments: RoomComposerAttachment[]
  uploading: UploadingRoomAttachment | null
  onRemove: (attachment: RoomComposerAttachment) => void
  onCancelUpload: () => void
}): React.JSX.Element | null {
  const [preview, setPreview] = useState<RoomImagePreview | null>(null)
  const items = uploading ? [...attachments, uploading] : attachments
  const visiblePreview =
    preview && items.some((attachment) => attachment.previewUrl === preview.src) ? preview : null
  if (items.length === 0) {
    return null
  }
  return (
    <>
      <div className="mb-2 flex gap-2 overflow-x-auto px-1 pb-1 scrollbar-sleek">
        {items.map((attachment) => {
          const isUploading = 'progress' in attachment
          const openPreview = attachment.previewUrl
            ? () =>
                setPreview({
                  fileName: attachment.fileName,
                  src: attachment.previewUrl!,
                  onDownload: () => downloadUrl(attachment.previewUrl!, attachment.fileName)
                })
            : undefined
          return (
            <AttachmentCard
              key={isUploading ? attachment.id : attachment.uploadId}
              fileName={attachment.fileName}
              byteSize={attachment.byteSize}
              imageUrl={attachment.previewUrl}
              onOpen={openPreview}
              onRemove={isUploading ? onCancelUpload : () => onRemove(attachment)}
              progress={isUploading ? attachment.progress : null}
            />
          )
        })}
      </div>
      <RoomImagePreviewDialog
        key={visiblePreview?.src}
        preview={visiblePreview}
        onOpenChange={(open) => !open && setPreview(null)}
      />
    </>
  )
}

export function RoomMessageAttachments({
  data,
  message,
  align = 'start'
}: {
  data: RoomData
  message: RoomMessage
  align?: 'start' | 'end'
}): React.JSX.Element | null {
  const [preview, setPreview] = useState<RoomImagePreview | null>(null)
  if (message.attachments.length === 0) {
    return null
  }
  return (
    <>
      <div className={`mt-2 flex flex-wrap gap-2 ${align === 'end' ? 'justify-end' : ''}`}>
        {message.attachments.map((attachment) => (
          <RoomMessageAttachmentCard
            key={attachment.id}
            data={data}
            message={message}
            attachment={attachment}
            onPreview={(src) =>
              setPreview({
                fileName: attachment.fileName,
                src,
                onDownload: () => void saveAttachment(data, message, attachment)
              })
            }
          />
        ))}
      </div>
      <RoomImagePreviewDialog
        key={preview?.src}
        preview={preview}
        onOpenChange={(open) => !open && setPreview(null)}
      />
    </>
  )
}

function RoomMessageAttachmentCard({
  data,
  message,
  attachment,
  onPreview
}: {
  data: RoomData
  message: RoomMessage
  attachment: RoomAttachment
  onPreview: (src: string) => void
}): React.JSX.Element {
  const image = isPreviewableImage(attachment.mimeType, attachment.fileName)
  const attachmentId = attachment.id
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(image)
  useEffect(() => {
    if (!image) {
      return
    }
    let active = true
    void readRoomAttachmentPreview(data.target, message.roomId, { id: attachmentId })
      .then((preview) => {
        if (!active || !preview) {
          return
        }
        setPreviewUrl(buildImageDataUri(preview.mimeType, preview.contentBase64))
      })
      .catch(() => {})
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [attachmentId, data.target, image, message.roomId])

  return (
    <AttachmentCard
      fileName={attachment.fileName}
      byteSize={attachment.byteSize}
      imageUrl={previewUrl}
      loading={loading}
      onOpen={
        previewUrl
          ? () => onPreview(previewUrl)
          : () => void saveAttachment(data, message, attachment)
      }
    />
  )
}

function AttachmentCard({
  fileName,
  byteSize,
  imageUrl,
  loading = false,
  progress,
  onOpen,
  onRemove
}: {
  fileName: string
  byteSize: number
  imageUrl: string | null
  loading?: boolean
  progress?: number | null
  onOpen?: () => void
  onRemove?: () => void
}): React.JSX.Element {
  const busy = loading || (progress !== null && progress !== undefined)
  if (imageUrl || loading) {
    return (
      <div className="relative size-20 shrink-0">
        <button
          type="button"
          className="size-full overflow-hidden rounded-lg border border-border bg-muted/30 text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onOpen}
          disabled={!onOpen}
          aria-label={fileName}
        >
          {imageUrl ? (
            <img src={imageUrl} alt={fileName} className="size-full object-cover" />
          ) : (
            <ImageIcon className="mx-auto size-6" />
          )}
          {busy ? (
            <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/70 text-xs tabular-nums">
              {progress === null || progress === undefined ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                `${progress}%`
              )}
            </span>
          ) : null}
        </button>
        {onRemove ? <RemoveAttachmentButton fileName={fileName} onClick={onRemove} /> : null}
      </div>
    )
  }
  return (
    <div className="relative flex h-14 w-56 shrink-0 items-center gap-2 rounded-lg border border-border bg-background px-2 pr-7 shadow-xs">
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={fileName}
      />
      <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <File className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs text-foreground">{fileName}</span>
        <span className="block text-[11px] text-muted-foreground">
          {progress === null || progress === undefined
            ? formatBytes(byteSize)
            : translate('rooms.composer.uploadProgressShort', 'Uploading… {{percent}}%', {
                percent: progress
              })}
        </span>
      </span>
      {onRemove ? <RemoveAttachmentButton fileName={fileName} onClick={onRemove} /> : null}
    </div>
  )
}

function RemoveAttachmentButton({
  fileName,
  onClick
}: {
  fileName: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="absolute right-1 top-1 z-10 flex size-4 items-center justify-center rounded-full bg-foreground text-background shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={onClick}
      aria-label={translate('rooms.composer.removeNamedAttachment', 'Remove {{fileName}}', {
        fileName
      })}
    >
      <X className="size-3" />
    </button>
  )
}

export function isPreviewableImage(mimeType: string, fileName: string): boolean {
  return (
    /^(image\/(gif|jpeg|png|webp))$/i.test(mimeType) || /\.(gif|jpe?g|png|webp)$/i.test(fileName)
  )
}

export function releaseRoomAttachmentPreview(previewUrl: string | null): void {
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl)
  }
}

export function releaseRoomAttachmentPreviews(attachments: RoomComposerAttachment[]): void {
  for (const attachment of attachments) {
    releaseRoomAttachmentPreview(attachment.previewUrl)
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function saveAttachment(
  data: RoomData,
  message: RoomMessage,
  attachment: RoomAttachment
): Promise<void> {
  const toastId = toast.loading(
    translate('rooms.attachment.downloading', 'Downloading {{fileName}}…', {
      fileName: attachment.fileName
    })
  )
  try {
    const path = await downloadRoomAttachment(data.target, message.roomId, attachment)
    if (path) {
      toast.success(translate('rooms.attachment.saved', 'Attachment saved'), { id: toastId })
    } else {
      toast.dismiss(toastId)
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error), { id: toastId })
  }
}

function downloadUrl(url: string, fileName: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
}
