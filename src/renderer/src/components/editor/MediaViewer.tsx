import { FileAudio, FileVideo } from 'lucide-react'
import { type JSX, useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type MediaViewerProps = {
  content: string
  filePath: string
  mimeType: string
}

// Why: object URLs stream to <video>/<audio> and support seeking; a data: URI
// would hold a second full copy of the file as a string for the src attribute.
function buildMediaObjectUrl(base64: string, mimeType: string): string | null {
  if (base64.length === 0) {
    return null
  }
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return URL.createObjectURL(new Blob([bytes], { type: mimeType }))
  } catch {
    return null
  }
}

function formatMediaFileSize(base64Length: number): string {
  const bytes = Math.floor((base64Length * 3) / 4)
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function MediaViewer({ content, filePath, mimeType }: MediaViewerProps): JSX.Element {
  const filename = useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath])
  const cleanedContent = useMemo(() => content.replace(/\s/g, ''), [content])
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [decodeAttempted, setDecodeAttempted] = useState(false)
  const [failedMediaUrl, setFailedMediaUrl] = useState<string | null>(null)

  useEffect(() => {
    const url = buildMediaObjectUrl(cleanedContent, mimeType)
    setMediaUrl(url)
    setDecodeAttempted(true)
    // Why: revoking on cleanup also unloads the player when the tab closes or
    // the file changes — the browser stops playback once the source is gone.
    return () => {
      setDecodeAttempted(false)
      if (url) {
        URL.revokeObjectURL(url)
      }
    }
  }, [cleanedContent, mimeType])

  const isVideo = mimeType.startsWith('video/')
  const mediaError = (decodeAttempted && mediaUrl === null) || (mediaUrl !== null && failedMediaUrl === mediaUrl)
  const MediaIcon = isVideo ? FileVideo : FileAudio

  if (mediaError) {
    return (
      <div
        data-orca-media-viewer="error"
        className="flex h-full flex-col items-center justify-center gap-3 bg-muted/20 p-8 text-sm text-muted-foreground"
      >
        <MediaIcon size={40} />
        <div>
          {translate(
            'auto.components.editor.MediaViewer.90b3c48af5',
            'Failed to load file preview'
          )}
        </div>
        <div className="max-w-md break-all text-center text-xs">{filename}</div>
      </div>
    )
  }

  if (!mediaUrl) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        {translate('auto.components.editor.MediaViewer.21f58fc57c', 'Loading preview...')}
      </div>
    )
  }

  return (
    <div data-orca-media-viewer="player" className="flex h-full min-h-0 flex-col">
      <div
        className={cn(
          'flex min-h-0 flex-1 items-center justify-center bg-muted/20',
          isVideo ? 'p-4' : 'p-8'
        )}
      >
        {isVideo ? (
          <video
            src={mediaUrl}
            controls
            className="max-h-full max-w-full"
            // Why: track the failed source identity, not a boolean, so a new
            // file retries immediately without waiting for an Effect reset.
            onError={() => setFailedMediaUrl(mediaUrl)}
          />
        ) : (
          <audio
            src={mediaUrl}
            controls
            className="w-full max-w-xl"
            onError={() => setFailedMediaUrl(mediaUrl)}
          />
        )}
      </div>
      <div className="flex items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate" title={filename}>
          {filename}
        </span>
        <span>{formatMediaFileSize(cleanedContent.length)}</span>
      </div>
    </div>
  )
}
