import { Loader2 } from 'lucide-react'
import { useEffect } from 'react'
import { useEmulatorFrameStream } from './use-emulator-frame-stream'
import { useEmulatorVideoStream } from './use-emulator-video-stream'
import { translate } from '@/i18n/i18n'

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

// Android sessions stream H.264 over scrcpy://<serial>; iOS uses an MJPEG http URL.
const SCRCPY_PREFIX = 'scrcpy://'

export function EmulatorScreenStreamContent({
  loading,
  onStreamError,
  onStreamSize,
  previewUrl,
  showStream,
  streamError,
  streamKey
}: EmulatorScreenStreamContentProps) {
  const androidDeviceId =
    previewUrl && previewUrl.startsWith(SCRCPY_PREFIX)
      ? previewUrl.slice(SCRCPY_PREFIX.length)
      : null

  const video = useEmulatorVideoStream(
    androidDeviceId ?? undefined,
    streamKey,
    showStream && Boolean(androidDeviceId),
    onStreamSize
  )
  const frameStream = useEmulatorFrameStream(
    androidDeviceId ? undefined : previewUrl,
    streamKey,
    showStream && Boolean(previewUrl) && !androidDeviceId
  )

  useEffect(() => {
    if (frameStream.error || video.error) {
      onStreamError()
    }
  }, [frameStream.error, video.error, onStreamError])

  if (androidDeviceId && showStream && !video.error) {
    return (
      <canvas
        ref={video.canvasRef}
        className="block h-full w-full bg-black object-contain"
        aria-label={translate(
          'auto.components.emulator.pane.emulator.screen.stream.content.5ee64cd44e',
          'Emulator screen'
        )}
      />
    )
  }

  if (showStream && frameStream.frameUrl) {
    return (
      <img
        key={`${previewUrl}::${streamKey ?? ''}`}
        src={frameStream.frameUrl}
        alt={translate(
          'auto.components.emulator.pane.emulator.screen.stream.content.5ee64cd44e',
          'Emulator screen'
        )}
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

  const waitingForFrame = showStream && !frameStream.error && !video.error
  const displayError = streamError || Boolean(frameStream.error) || Boolean(video.error)

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-muted/20 text-muted-foreground">
      {loading || waitingForFrame ? (
        <>
          <Loader2 className="size-6 animate-spin text-primary" />
          <span className="text-xs">
            {translate(
              'auto.components.emulator.pane.emulator.screen.stream.content.5f818f12ab',
              'Connecting emulator…'
            )}
          </span>
        </>
      ) : displayError ? (
        <span className="px-6 text-center text-xs">
          {translate(
            'auto.components.emulator.pane.emulator.screen.stream.content.36841af608',
            'Stream disconnected'
          )}
        </span>
      ) : (
        <span className="px-6 text-center text-xs">
          {translate(
            'auto.components.emulator.pane.emulator.screen.stream.content.8b1a0d8694',
            'Emulator preview'
          )}
        </span>
      )}
    </div>
  )
}
