import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent
} from 'react'
import {
  fitDeviceFrameToPane,
  resolveVisualStreamGeometry,
  resolveDeviceFrameKind,
  type EmulatorDeviceVisualOrientation,
  type StreamSize
} from './emulator-device-frame-layout'
import {
  buildWheelGesturePoints,
  clampEmulatorScreenPoint,
  buildEmulatorGesturePoint,
  mapClientPointToSimulatorScreen,
  resolveEmulatorWheelDelta,
  resolveEmulatorHomeIndicatorEdge,
  resolveEmulatorPointerAction,
  type EmulatorScreenPoint,
  type EmulatorGesturePoint,
  type PointerSample
} from './emulator-screen-gesture'
import { PhoneHardwareButtons } from './emulator-phone-hardware-buttons'
import { EmulatorScreenSurface } from './emulator-screen-surface'
import { useEmulatorControlStream } from './use-emulator-control-stream'
import { useEmulatorPaneSize } from './use-emulator-pane-size'
import { useEmulatorScreenKeyboard } from './use-emulator-screen-keyboard'

type EmulatorDeviceFrameProps = {
  previewUrl?: string
  wsUrl?: string
  streamKey?: string
  deviceName?: string
  loading: boolean
  isLive: boolean
  visualOrientation: EmulatorDeviceVisualOrientation
  /** False when backgrounded; parks the stream with the pane's visibility. */
  isActive: boolean
  onTap: (x: number, y: number) => void
  onGesture: (points: EmulatorGesturePoint[]) => void
}

const MAX_GESTURE_SAMPLES = 32,
  WHEEL_GESTURE_IDLE_MS = 80
type PendingWheelGesture = {
  end: EmulatorScreenPoint
  live: boolean
  start: EmulatorScreenPoint
  timerId: number | null
}

type ScreenCoordinateEvent = Pick<
  PointerEvent<HTMLDivElement>,
  'clientX' | 'clientY' | 'currentTarget'
>

export function EmulatorDeviceFrame({
  previewUrl,
  wsUrl,
  streamKey,
  deviceName,
  loading,
  isLive,
  visualOrientation,
  isActive,
  onTap,
  onGesture
}: EmulatorDeviceFrameProps) {
  const { paneRef, paneSize } = useEmulatorPaneSize()
  const pointerSamplesRef = useRef<PointerSample[] | null>(null)
  const activePointerIdRef = useRef<number | null>(null)
  const liveTouchRef = useRef(false)
  const liveTouchEdgeRef = useRef<number | undefined>(undefined)
  const lastTouchPointRef = useRef<EmulatorScreenPoint | null>(null)
  const wheelGestureRef = useRef<PendingWheelGesture | null>(null)
  const [streamError, setStreamError] = useState(false)
  const [streamSize, setStreamSize] = useState<StreamSize | null>(null)
  const visualStreamGeometry = useMemo(
    () => resolveVisualStreamGeometry(streamSize, visualOrientation),
    [streamSize, visualOrientation]
  )
  const canInteract = isLive && !loading && !streamError
  const { cancelKeyboardFrames, sendKeyboardFrames, sendTouch } = useEmulatorControlStream(
    wsUrl,
    canInteract
  )
  const { enableKeyboardCapture, handleBlur, handleKeyDown, handlePaste, keyboardCaptureActive } =
    useEmulatorScreenKeyboard({
      cancelKeyboardFrames,
      canInteract,
      sendKeyboardFrames
    })

  useEffect(() => {
    setStreamError(false)
    setStreamSize(null)
  }, [previewUrl, streamKey])

  const mapEventToScreenPoint = useCallback(
    (event: ScreenCoordinateEvent): EmulatorScreenPoint | null =>
      mapClientPointToSimulatorScreen(
        { clientX: event.clientX, clientY: event.clientY },
        event.currentTarget.getBoundingClientRect(),
        visualStreamGeometry.size
      ),
    [visualStreamGeometry.size]
  )

  const sendGesturePoints = useCallback(
    (points: EmulatorGesturePoint[]) => {
      void onGesture(points)
    },
    [onGesture]
  )

  const flushWheelGesture = useCallback(() => {
    const pending = wheelGestureRef.current
    wheelGestureRef.current = null
    if (!pending) {
      return
    }
    if (pending.timerId !== null) {
      window.clearTimeout(pending.timerId)
    }
    if (pending.live) {
      const end = clampEmulatorScreenPoint(pending.end)
      void sendTouch({ ...end, type: 'end' })
      return
    }
    const points = buildWheelGesturePoints(pending.start, pending.end)
    if (points) {
      sendGesturePoints(points)
    }
  }, [sendGesturePoints, sendTouch])

  useEffect(
    () => () => {
      const pending = wheelGestureRef.current
      if (pending?.timerId != null) {
        window.clearTimeout(pending.timerId)
      }
      if (pending?.live) {
        const end = clampEmulatorScreenPoint(pending.end)
        void sendTouch({ ...end, type: 'end' })
      }
      const point = lastTouchPointRef.current
      if (liveTouchRef.current && point) {
        void sendTouch(buildEmulatorGesturePoint(point, 'end', liveTouchEdgeRef.current))
      }
      wheelGestureRef.current = null
      liveTouchRef.current = false
      liveTouchEdgeRef.current = undefined
      lastTouchPointRef.current = null
    },
    [sendTouch]
  )

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!canInteract || event.button !== 0) {
        return
      }
      event.preventDefault()
      try {
        event.currentTarget.focus({ preventScroll: true })
      } catch {}
      enableKeyboardCapture()
      const point = mapEventToScreenPoint(event)
      if (!point) {
        return
      }
      activePointerIdRef.current = event.pointerId
      pointerSamplesRef.current = [{ clientX: event.clientX, clientY: event.clientY }]
      lastTouchPointRef.current = point
      liveTouchEdgeRef.current = resolveEmulatorHomeIndicatorEdge(point)
      // Why: serve-sim's native viewer streams touch phases live; replaying the
      // whole drag after pointer-up can be ignored by iOS gesture recognizers.
      liveTouchRef.current = sendTouch(
        buildEmulatorGesturePoint(point, 'begin', liveTouchEdgeRef.current)
      )
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {}
    },
    [canInteract, enableKeyboardCapture, mapEventToScreenPoint, sendTouch]
  )

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const samples = pointerSamplesRef.current
      if (!samples || activePointerIdRef.current !== event.pointerId) {
        return
      }
      event.preventDefault()
      const last = samples.at(-1)
      if (last && Math.hypot(event.clientX - last.clientX, event.clientY - last.clientY) < 4) {
        return
      }
      const sample = { clientX: event.clientX, clientY: event.clientY }
      if (samples.length < MAX_GESTURE_SAMPLES - 1) {
        samples.push(sample)
      } else {
        samples[samples.length - 1] = sample
      }
      if (!liveTouchRef.current) {
        return
      }
      const point = mapEventToScreenPoint(event)
      if (point) {
        lastTouchPointRef.current = point
        void sendTouch(buildEmulatorGesturePoint(point, 'move', liveTouchEdgeRef.current))
      }
    },
    [mapEventToScreenPoint, sendTouch]
  )

  const handlePointerCancel = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (activePointerIdRef.current !== event.pointerId) {
        return
      }
      const point = lastTouchPointRef.current
      if (liveTouchRef.current && point) {
        void sendTouch(buildEmulatorGesturePoint(point, 'end', liveTouchEdgeRef.current))
      }
      pointerSamplesRef.current = null
      activePointerIdRef.current = null
      liveTouchRef.current = false
      liveTouchEdgeRef.current = undefined
      lastTouchPointRef.current = null
    },
    [sendTouch]
  )

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const samples = pointerSamplesRef.current
      if (!samples || activePointerIdRef.current !== event.pointerId) {
        return
      }
      event.preventDefault()
      pointerSamplesRef.current = null
      activePointerIdRef.current = null
      const endPoint = mapEventToScreenPoint(event) ?? lastTouchPointRef.current
      if (liveTouchRef.current) {
        if (endPoint) {
          void sendTouch(buildEmulatorGesturePoint(endPoint, 'end', liveTouchEdgeRef.current))
        }
        liveTouchRef.current = false
        liveTouchEdgeRef.current = undefined
        lastTouchPointRef.current = null
        return
      }
      liveTouchEdgeRef.current = undefined
      lastTouchPointRef.current = null
      if (!canInteract) {
        return
      }
      samples.push({ clientX: event.clientX, clientY: event.clientY })
      const action = resolveEmulatorPointerAction(
        samples,
        event.currentTarget.getBoundingClientRect(),
        visualStreamGeometry.size
      )
      if (!action) {
        return
      }
      if (action.kind === 'tap') {
        void onTap(action.point.x, action.point.y)
      } else {
        sendGesturePoints(action.points)
      }
    },
    [canInteract, mapEventToScreenPoint, onTap, sendGesturePoints, sendTouch, visualStreamGeometry]
  )

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (!canInteract) {
        return
      }
      const delta = resolveEmulatorWheelDelta(
        {
          clientX: event.clientX,
          clientY: event.clientY,
          deltaMode: event.deltaMode,
          deltaX: event.deltaX,
          deltaY: event.deltaY
        },
        event.currentTarget.getBoundingClientRect(),
        visualStreamGeometry.size
      )
      if (!delta) {
        return
      }
      event.preventDefault()
      const previous = wheelGestureRef.current
      if (previous?.timerId != null) {
        window.clearTimeout(previous.timerId)
      }
      const start = previous?.start ?? delta.start
      const end = clampEmulatorScreenPoint(
        previous
          ? { x: previous.end.x + delta.delta.x, y: previous.end.y + delta.delta.y }
          : { x: delta.start.x + delta.delta.x, y: delta.start.y + delta.delta.y }
      )
      const live = previous?.live ?? sendTouch({ ...start, type: 'begin' })
      if (live) {
        void sendTouch({ ...end, type: 'move' })
      }
      wheelGestureRef.current = {
        start,
        end,
        live,
        timerId: window.setTimeout(flushWheelGesture, WHEEL_GESTURE_IDLE_MS)
      }
    },
    [canInteract, flushWheelGesture, sendTouch, visualStreamGeometry]
  )

  const handleStreamSize = useCallback((size: NonNullable<StreamSize>) => {
    setStreamError(false)
    setStreamSize((current) =>
      current?.width === size.width && current.height === size.height ? current : size
    )
  }, [])

  const handleStreamError = useCallback(() => {
    setStreamError(true)
  }, [])

  // Why: hidden panes still receive emulator frames, including over SSH, so
  // parking the stream avoids background decode/IPC churn while staying attached.
  const showStream = isActive && isLive && Boolean(previewUrl)
  const streamAspectRatio = streamSize ? streamSize.width / streamSize.height : 9 / 19
  // Why: serve-sim may keep portrait-sized pixels for portrait-locked apps; the
  // physical frame still follows the last successful rotate request.
  const screenAspectRatio = visualStreamGeometry.aspectRatio
  const frameKind = useMemo(
    () => resolveDeviceFrameKind(deviceName, streamAspectRatio),
    [deviceName, streamAspectRatio]
  )
  const frameLayout = useMemo(
    () => fitDeviceFrameToPane(paneSize, screenAspectRatio, frameKind),
    [frameKind, screenAspectRatio, paneSize]
  )

  return (
    <div
      ref={paneRef}
      className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted"
    >
      <div
        className="relative"
        style={{
          width: frameLayout ? `${frameLayout.width}px` : '100%',
          maxWidth: frameLayout ? undefined : '460px',
          height: frameLayout ? `${frameLayout.height}px` : undefined
        }}
      >
        {frameLayout?.kind === 'phone' ? <PhoneHardwareButtons layout={frameLayout} /> : null}
        <div
          data-orca-emulator-frame="true"
          className="relative overflow-hidden bg-black shadow-lg ring-1 ring-black/25"
          style={{
            left: frameLayout ? `${frameLayout.hardwareOutset}px` : undefined,
            width: frameLayout ? `${frameLayout.shellWidth}px` : '100%',
            height: frameLayout ? `${frameLayout.shellHeight}px` : undefined,
            padding: frameLayout ? undefined : '10px',
            borderRadius: frameLayout ? `${frameLayout.outerRadius}px` : '54px'
          }}
        >
          <EmulatorScreenSurface
            frameLayout={frameLayout}
            isLive={isLive}
            keyboardCaptureActive={keyboardCaptureActive}
            loading={loading}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onPointerCancel={handlePointerCancel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onStreamError={handleStreamError}
            onStreamSize={handleStreamSize}
            onWheel={handleWheel}
            previewUrl={previewUrl}
            screenAspectRatio={screenAspectRatio}
            showStream={Boolean(showStream)}
            streamError={streamError}
            streamKey={streamKey}
            streamRotation={visualStreamGeometry.streamRotation}
          />
        </div>
      </div>
    </div>
  )
}
