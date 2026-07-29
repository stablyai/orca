import type {
  ClipboardEventHandler,
  FocusEventHandler,
  KeyboardEventHandler,
  PointerEventHandler,
  WheelEventHandler
} from 'react'
import { cn } from '@/lib/utils'
import { getEmulatorScreenAriaLabel } from './emulator-screen-aria-label'
import { EmulatorScreenStreamContent } from './emulator-screen-stream-content'
import type {
  DeviceFrameLayout,
  StreamSize,
  VisualStreamGeometry
} from './emulator-device-frame-layout'

type EmulatorScreenSurfaceProps = {
  frameLayout: DeviceFrameLayout | null
  isLive: boolean
  keyboardCaptureActive: boolean
  loading: boolean
  onBlur: FocusEventHandler<HTMLDivElement>
  onKeyDown: KeyboardEventHandler<HTMLDivElement>
  onPaste: ClipboardEventHandler<HTMLDivElement>
  onPointerCancel: PointerEventHandler<HTMLDivElement>
  onPointerDown: PointerEventHandler<HTMLDivElement>
  onPointerMove: PointerEventHandler<HTMLDivElement>
  onPointerUp: PointerEventHandler<HTMLDivElement>
  onStreamError: () => void
  onStreamSize: (size: StreamSize) => void
  onWheel: WheelEventHandler<HTMLDivElement>
  previewUrl?: string
  screenAspectRatio: number
  showStream: boolean
  streamError: boolean
  streamKey?: string
  streamRotation: VisualStreamGeometry['streamRotation']
}

export function EmulatorScreenSurface({
  frameLayout,
  isLive,
  keyboardCaptureActive,
  loading,
  onBlur,
  onKeyDown,
  onPaste,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onStreamError,
  onStreamSize,
  onWheel,
  previewUrl,
  screenAspectRatio,
  showStream,
  streamError,
  streamKey,
  streamRotation
}: EmulatorScreenSurfaceProps) {
  return (
    <div
      className={cn(
        frameLayout
          ? 'absolute overflow-hidden bg-black ring-1 ring-white/10'
          : 'relative w-full overflow-hidden bg-black ring-1 ring-white/10',
        isLive && 'touch-none select-none'
      )}
      style={{
        inset: frameLayout ? `${frameLayout.bezel}px` : undefined,
        aspectRatio: frameLayout ? undefined : `${screenAspectRatio}`,
        borderRadius: frameLayout ? `${frameLayout.innerRadius}px` : '44px'
      }}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onWheel={onWheel}
      role={isLive ? 'application' : undefined}
      tabIndex={isLive ? 0 : undefined}
      aria-keyshortcuts={keyboardCaptureActive ? 'Escape' : undefined}
      aria-label={getEmulatorScreenAriaLabel(isLive, keyboardCaptureActive)}
    >
      {/* Why: the stream is the actual emulator screen; fake in-screen chrome
          doubles up with iOS's real status bar and makes bezels lie. */}
      <EmulatorScreenStreamContent
        loading={loading}
        onStreamError={onStreamError}
        onStreamSize={onStreamSize}
        previewUrl={previewUrl}
        screenAspectRatio={screenAspectRatio}
        showStream={showStream}
        streamError={streamError}
        streamKey={streamKey}
        streamRotation={streamRotation}
      />
    </div>
  )
}
