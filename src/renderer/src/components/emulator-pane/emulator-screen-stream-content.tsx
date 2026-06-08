import { Loader2 } from 'lucide-react'
import { useEffect } from 'react'
import { useEmulatorFrameStream } from './use-emulator-frame-stream'

type StreamSize = {
  height: number
  width: number
}

type EmulatorScreenStreamContentProps = {
  loading: boolean
  onStreamError: () => void
  onStreamSize: (size: StreamSize) => void
  previewUrl?: string
  showStream: boolean
  streamError: boolean
  streamKey?: string
}

export function EmulatorScreenStreamContent({
  loading,
  onStreamError,
  onStreamSize,
  previewUrl,
  showStream,
  streamError,
  streamKey
}: EmulatorScreenStreamContentProps) {
  const frameStream = useEmulatorFrameStream(
    previewUrl,
    streamKey,
    showStream && Boolean(previewUrl)
  )

  useEffect(() => {
    if (frameStream.error) {
      onStreamError()
    }
  }, [frameStream.error, onStreamError])

  if (showStream && frameStream.frameUrl) {
    return (
      <img
        key={`${previewUrl}::${streamKey ?? ''}`}
        src={frameStream.frameUrl}
        alt="Emulator screen"
        className="block h-full w-full bg-black object-contain"
        draggable={false}
        onError={onStreamError}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget
          if (naturalWidth <= 0 || naturalHeight <= 0) {
            return
          }
          onStreamSize({ width: naturalWidth, height: naturalHeight })
        }}
      />
    )
  }

  const waitingForFrame = showStream && !frameStream.error
  const displayError = streamError || Boolean(frameStream.error)

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-muted/20 text-muted-foreground">
      {loading || waitingForFrame ? (
        <>
          <Loader2 className="size-6 animate-spin text-primary" />
          <span className="text-xs">Connecting emulator…</span>
        </>
      ) : displayError ? (
        <span className="px-6 text-center text-xs">Stream disconnected</span>
      ) : (
        <span className="px-6 text-center text-xs">Emulator preview</span>
      )}
    </div>
  )
}
