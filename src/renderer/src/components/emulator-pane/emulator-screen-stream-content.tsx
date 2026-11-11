import { Loader2 } from 'lucide-react'
import { useEffect, useState, type CSSProperties } from 'react'
import { useEmulatorFrameStream } from './use-emulator-frame-stream'
import { useEmulatorVideoStream } from './use-emulator-video-stream'
import { scrcpyDeviceIdFromStreamUrl } from './emulator-scrcpy-stream-url'
import { useTranslate } from '@/i18n/use-translate'
import type { VisualStreamGeometry } from './emulator-device-frame-layout'

type StreamSize = {
  height: number
  width: number
}

type EmulatorScreenStreamContentProps = {
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
  const t = useTranslate()
  const androidDeviceId = scrcpyDeviceIdFromStreamUrl(previewUrl)
  const iosVideoSession =
    !androidDeviceId && deviceId && previewUrl ? `${deviceId}\n${previewUrl}\n${streamKey}` : null
  const [failedIosVideoSession, setFailedIosVideoSession] = useState<string | null>(null)
  const iosVideo = iosVideoSession !== null && iosVideoSession !== failedIosVideoSession
  const videoDeviceId = androidDeviceId ?? (iosVideo ? deviceId : undefined)

  const { canvasRef, error: videoError } = useEmulatorVideoStream(
    videoDeviceId,
    streamKey,
    showStream && Boolean(videoDeviceId),
    onStreamSize,
    iosVideo ? 'avcc' : 'annex-b'
  )
  const iosVideoFailed = iosVideo && Boolean(videoError)
  const jpeg = !androidDeviceId && (!iosVideo || iosVideoFailed)
  const frameStream = useEmulatorFrameStream(
    jpeg ? previewUrl : undefined,
    streamKey,
    showStream && Boolean(previewUrl) && jpeg
  )
  const mediaError = frameStream.error ?? (androidDeviceId ? videoError : null)

  useEffect(() => {
    if (iosVideoFailed) {
      setFailedIosVideoSession(iosVideoSession)
    }
  }, [iosVideoFailed, iosVideoSession])

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

  if (videoDeviceId && showStream && !videoError) {
    return (
      <canvas
        ref={canvasRef}
        className={mediaClassName}
        style={mediaStyle}
        aria-label={t(
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
        alt={t(
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
            {t(
              'auto.components.emulator.pane.emulator.screen.stream.content.5f818f12ab',
              'Connecting emulator…'
            )}
          </span>
        </>
      ) : displayError ? (
        <span className="px-6 text-center text-xs">
          {t(
            'auto.components.emulator.pane.emulator.screen.stream.content.36841af608',
            'Stream disconnected'
          )}
        </span>
      ) : (
        <span className="px-6 text-center text-xs">
          {t(
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
