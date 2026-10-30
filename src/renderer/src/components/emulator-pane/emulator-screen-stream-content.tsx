import { Loader2 } from 'lucide-react'
import { useEffect, type CSSProperties } from 'react'
import { useEmulatorFrameStream } from './use-emulator-frame-stream'
import { useEmulatorVideoStream } from './use-emulator-video-stream'
import { translate } from '@/i18n/i18n'
import type { VisualStreamGeometry } from './emulator-device-frame-layout'

type StreamSize = {
  height: number
  width: number
}

type EmulatorScreenStreamContentProps = {
  loading: boolean
  onStreamError: () => void
  onStreamSize: (size: StreamSize) => void
  previewUrl?: string
  screenAspectRatio?: number
  showStream: boolean
  streamError: boolean
  streamKey?: string
  streamRotation?: VisualStreamGeometry['streamRotation']
}

// Android sessions stream H.264 over scrcpy://<serial>; iOS uses an MJPEG http URL.
const SCRCPY_PREFIX = 'scrcpy://'

export function EmulatorScreenStreamContent({
  loading,
  onStreamError,
  onStreamSize,
  previewUrl,
  screenAspectRatio = 9 / 19,
  showStream,
  streamError,
  streamKey,
  streamRotation = 0
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

  const mediaStyle = resolveStreamMediaStyle(streamRotation, screenAspectRatio)
  const mediaClassName =
    streamRotation === 0
      ? 'block h-full w-full bg-black object-contain'
      : 'absolute left-1/2 top-1/2 block max-w-none bg-black object-contain'

  if (androidDeviceId && showStream && !video.error) {
    return (
      <canvas
        ref={video.canvasRef}
        className={mediaClassName}
        style={mediaStyle}
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
        className={mediaClassName}
        draggable={false}
        style={mediaStyle}
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

function resolveStreamMediaStyle(
  streamRotation: VisualStreamGeometry['streamRotation'],
  screenAspectRatio: number
): CSSProperties | undefined {
  if (streamRotation === 0 || screenAspectRatio <= 0) {
    return undefined
  }
  return {
    height: `${100 * screenAspectRatio}%`,
    transform: `translate(-50%, -50%) rotate(${streamRotation}deg)`,
    transformOrigin: 'center',
    width: `${100 / screenAspectRatio}%`
  }
}
