import { useEffect, useRef } from 'react'
import type { DesktopAppWindow } from '../../../../shared/desktop-app-types'
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
  const input = useDesktopAppInput(target, videoRef, onInputError)

  useEffect(() => {
    const video = videoRef.current
    if (video && video.srcObject !== stream) {
      video.srcObject = stream
    }
  }, [stream])

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-muted">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        tabIndex={0}
        aria-label={target.title || target.appName}
        onPointerDown={input.onPointerDown}
        onMouseUp={input.onMouseUp}
        onWheel={input.onWheel}
        onKeyDown={input.onKeyDown}
        onPaste={input.onPaste}
        onContextMenu={(event) => event.preventDefault()}
        className="size-full object-contain outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      />
    </div>
  )
}
