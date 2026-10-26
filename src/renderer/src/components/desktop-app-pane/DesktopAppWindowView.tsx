import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopAppWindow } from '../../../../shared/desktop-app-types'
import { DesktopAppAgentOverlay } from './DesktopAppAgentOverlay'
import { mapWindowPointToElementPoint, type Size } from './desktop-app-point-mapping'
import { useDesktopAppAgentControl } from './use-desktop-app-agent-control'
import { useDesktopAppInput } from './use-desktop-app-input'

type DesktopAppWindowViewProps = {
  target: DesktopAppWindow
  stream: MediaStream | null
  onInputError: (message: string | null) => void
}

/** The live picture of the chosen window; clicks, scroll and typing go to the real window. */
export function DesktopAppWindowView({
  target,
  stream,
  onInputError
}: DesktopAppWindowViewProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [box, setBox] = useState<Size>({ width: 0, height: 0 })
  const [media, setMedia] = useState<Size>({ width: 0, height: 0 })
  const input = useDesktopAppInput(target, videoRef, onInputError)
  const control = useDesktopAppAgentControl(target)

  useEffect(() => {
    const video = videoRef.current
    if (video && video.srcObject !== stream) {
      video.srcObject = stream
    }
  }, [stream])

  useEffect(() => {
    const video = videoRef.current
    if (!video) {
      return
    }
    const observer = new ResizeObserver(() =>
      setBox({ width: video.clientWidth, height: video.clientHeight })
    )
    observer.observe(video)
    return () => observer.disconnect()
  }, [])

  const onMediaResize = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget
    setMedia({ width: video.videoWidth, height: video.videoHeight })
  }, [])

  const windowSize = { width: target.bounds.width, height: target.bounds.height }
  const cursor = control.cursor
    ? mapWindowPointToElementPoint(control.cursor, box, media, windowSize)
    : null

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-muted">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        tabIndex={0}
        aria-label={target.title || target.appName}
        onLoadedMetadata={onMediaResize}
        onResize={onMediaResize}
        onPointerDown={input.onPointerDown}
        onMouseUp={input.onMouseUp}
        onWheel={input.onWheel}
        onKeyDown={input.onKeyDown}
        onPaste={input.onPaste}
        onContextMenu={(event) => event.preventDefault()}
        className="size-full object-contain outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      />
      <DesktopAppAgentOverlay
        controlling={control.controlling}
        stopped={control.stopped}
        cursor={cursor}
        cursorOrigin={{ x: box.width / 2, y: box.height / 2 }}
        onStop={control.stopAgent}
        onAllow={control.allowAgent}
      />
    </div>
  )
}
