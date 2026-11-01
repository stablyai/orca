import { Loader2 } from 'lucide-react'
import { useEffect, type CSSProperties } from 'react'
import { useEmulatorFrameStream } from './use-emulator-frame-stream'
import { useEmulatorVideoStream } from './use-emulator-video-stream'
import { scrcpyDeviceIdFromStreamUrl } from './emulator-scrcpy-stream-url'
import { translate } from '@/i18n/i18n'
import type { VisualStreamGeometry } from './emulator-device-frame-layout'

type StreamSize = {
  height: number
  width: number
}

type EmulatorScreenStreamContentProps = {
  avccStreamUrl?: string
  deviceId?: string
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

export function EmulatorScreenStreamContent({
  avccStreamUrl,
  deviceId,
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
  const androidDeviceId = scrcpyDeviceIdFromStreamUrl(previewUrl)
  const iosVideo = !androidDeviceId && Boolean(deviceId && avccStreamUrl)
  const wantsVideo = Boolean(androidDeviceId) || iosVideo

  const video = useEmulatorVideoStream(
    androidDeviceId ?? (iosVideo ? deviceId : undefined),
    streamKey,
    showStream && wantsVideo,
    onStreamSize,
    iosVideo ? avccStreamUrl : undefined
  )
  // Keep video enabled after failure: its sticky error owns this session's JPEG fallback.
  const wantsJpeg = !androidDeviceId && (!iosVideo || Boolean(video.error))
  const frameStream = useEmulatorFrameStream(
    wantsJpeg ? previewUrl : undefined,
    streamKey,
    showStream && Boolean(previewUrl) && wantsJpeg
  )
  const mediaError = frameStream.error || (androidDeviceId ? video.error : null)

  useEffect(() => {
    if (mediaError) {
      onStreamError()
    }
  }, [mediaError, onStreamError])

  const mediaStyle = resolveStreamMediaStyle(streamRotation, screenAspectRatio)
  const mediaClassName =
    streamRotation === 0
      ? 'block h-full w-full bg-black object-contain'
      : 'absolute left-1/2 top-1/2 block max-w-none bg-black object-contain'

  if (wantsVideo && showStream && !video.error) {
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

  const waitingForFrame = showStream && !mediaError
  const displayError = streamError || Boolean(mediaError)

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
  // A half turn keeps the frame's own proportions; only quarter turns swap them.
  const halfTurn = streamRotation === 180
  return {
    height: `${halfTurn ? 100 : 100 * screenAspectRatio}%`,
    transform: `translate(-50%, -50%) rotate(${streamRotation}deg)`,
    transformOrigin: 'center',
    width: `${halfTurn ? 100 : 100 / screenAspectRatio}%`
  }
}
