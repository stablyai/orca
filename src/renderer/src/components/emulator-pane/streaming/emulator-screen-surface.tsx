import type {
  ClipboardEventHandler,
  CompositionEvent,
  FocusEventHandler,
  FormEvent,
  KeyboardEventHandler,
  PointerEvent,
  PointerEventHandler,
  RefObject,
  WheelEventHandler
} from 'react'
import { cn } from '@/lib/class-names'
import { getEmulatorScreenAriaLabel } from './emulator-screen-aria-label'
import { EmulatorScreenStreamContent } from './emulator-screen-stream-content'
import type {
  DeviceFrameLayout,
  StreamSize,
  VisualStreamGeometry
} from '../frame/emulator-device-frame-layout'
import { useTranslate } from '@/i18n/use-translate'

// Gap between the composing text and the screen edge or the tapped point.
const PROXY_MARGIN_PX = 8

// Puts the composing text just under the last tap (where the guest's field usually is), inside the screen.
function placeKeyboardProxy(proxy: HTMLTextAreaElement): void {
  const screen = proxy.parentElement
  if (!screen) {
    return
  }
  const width = screen.clientWidth
  const height = screen.clientHeight
  const x = Number(screen.dataset.tapX ?? width / 2)
  const y = Number(screen.dataset.tapY ?? height * 0.75)
  const clamp = (value: number, max: number) =>
    Math.max(PROXY_MARGIN_PX, Math.min(value, max - PROXY_MARGIN_PX))
  proxy.style.left = `${clamp(x - proxy.offsetWidth / 2, width - proxy.offsetWidth)}px`
  proxy.style.top = `${clamp(y + PROXY_MARGIN_PX, height - proxy.offsetHeight)}px`
}

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
  const recordTapPoint = (event: PointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    event.currentTarget.dataset.tapX = String(event.clientX - rect.left)
    event.currentTarget.dataset.tapY = String(event.clientY - rect.top)
  }
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
      onPointerDownCapture={recordTapPoint}
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
        <textarea
          ref={keyboardProxyRef}
          data-emulator-keyboard-proxy=""
          aria-label={ariaLabel}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          rows={1}
          tabIndex={-1}
          className="pointer-events-none absolute top-0 left-0 z-10 m-0 size-px resize-none overflow-hidden whitespace-pre border-0 bg-transparent p-0 text-transparent caret-transparent opacity-0 outline-none [field-sizing:content] data-[composing]:size-auto data-[composing]:max-w-[calc(100%-16px)] data-[composing]:rounded-md data-[composing]:border data-[composing]:border-border data-[composing]:bg-popover data-[composing]:px-2 data-[composing]:py-1 data-[composing]:text-sm data-[composing]:text-popover-foreground data-[composing]:caret-current data-[composing]:opacity-100 data-[composing]:shadow-floating"
          onCompositionStart={(event) => {
            event.currentTarget.dataset.composing = ''
            placeKeyboardProxy(event.currentTarget)
          }}
          onCompositionUpdate={(event) => placeKeyboardProxy(event.currentTarget)}
          onCompositionEnd={(event) => {
            delete event.currentTarget.dataset.composing
            onKeyboardProxyCompositionEnd(event)
          }}
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
