import type {
  ClipboardEventHandler,
  CompositionEvent,
  FocusEventHandler,
  FormEvent,
  KeyboardEventHandler,
  PointerEventHandler,
  RefObject,
  WheelEventHandler
} from 'react'
import { cn } from '@/lib/class-names'
import {
  ComposingKeyboardProxy,
  recordComposingKeyboardProxyAnchor
} from '@/lib/text-input/ime/composing-keyboard-proxy'
import { getEmulatorScreenAriaLabel } from './emulator-screen-aria-label'
import { EmulatorScreenStreamContent } from './emulator-screen-stream-content'
import type {
  DeviceFrameLayout,
  StreamSize,
  VisualStreamGeometry
} from '../frame/emulator-device-frame-layout'
import { useTranslate } from '@/i18n/use-translate'

type EmulatorScreenSurfaceProps = {
  deviceId?: string
  frameLayout: DeviceFrameLayout | null
  isLive: boolean
  keyboardCaptureActive: boolean
  keyboardProxyRef: RefObject<HTMLTextAreaElement | null>
  loading: boolean
  onBlur: FocusEventHandler<HTMLDivElement>
  onKeyboardProxyCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => void
  onKeyboardProxyInput: (event: FormEvent<HTMLTextAreaElement>) => void
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
  deviceId,
  frameLayout,
  isLive,
  keyboardCaptureActive,
  keyboardProxyRef,
  loading,
  onBlur,
  onKeyboardProxyCompositionEnd,
  onKeyboardProxyInput,
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
  const t = useTranslate()
  const ariaLabel = getEmulatorScreenAriaLabel(isLive, keyboardCaptureActive, t)
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
      onPointerDownCapture={recordComposingKeyboardProxyAnchor}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onBlur={onBlur}
      onFocus={(event) => {
        // Keyboard focus belongs to the proxy, so a Tab onto the screen lands there.
        if (isLive && event.target === event.currentTarget) {
          event.currentTarget
            .querySelector<HTMLTextAreaElement>('[data-emulator-keyboard-proxy]')
            ?.focus({ preventScroll: true })
        }
      }}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onWheel={onWheel}
      role={isLive ? 'application' : undefined}
      tabIndex={isLive ? 0 : undefined}
      aria-keyshortcuts={keyboardCaptureActive ? 'Escape' : undefined}
      aria-label={ariaLabel}
    >
      {isLive ? (
        <ComposingKeyboardProxy
          ref={keyboardProxyRef}
          data-emulator-keyboard-proxy=""
          aria-label={ariaLabel}
          onCompositionEnd={onKeyboardProxyCompositionEnd}
          onInput={onKeyboardProxyInput}
        />
      ) : null}
      {/* Use the real streamed screen; extra in-screen chrome would duplicate iOS status bars and distort bezels. */}
      <EmulatorScreenStreamContent
        deviceId={deviceId}
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
