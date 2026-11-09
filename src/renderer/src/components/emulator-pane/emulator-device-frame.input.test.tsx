// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EmulatorDeviceFrame } from './emulator-device-frame'
import type { EmulatorGesturePoint } from './emulator-screen-gesture'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3

  static instances: FakeWebSocket[] = []

  binaryType: BinaryType = 'blob'
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  readyState = FakeWebSocket.CONNECTING
  readonly sent: Uint8Array[] = []
  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (data instanceof Uint8Array) {
      this.sent.push(data)
      return
    }
    if (ArrayBuffer.isView(data)) {
      this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      return
    }
    if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data))
    }
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  FakeWebSocket.instances = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function renderFrame(props?: {
  isLive?: boolean
  onGesture?: (points: EmulatorGesturePoint[]) => void
  onTap?: (x: number, y: number) => void
  previewUrl?: string
  wsUrl?: string
}): void {
  act(() => {
    root.render(
      <EmulatorDeviceFrame
        previewUrl={props?.previewUrl ?? 'http://127.0.0.1:3100/stream.mjpeg'}
        wsUrl={props?.wsUrl ?? 'ws://127.0.0.1:3100/ws'}
        loading={false}
        isLive={props?.isLive ?? true}
        visualOrientation="portrait"
        isActive={true}
        onTap={props?.onTap ?? vi.fn()}
        onGesture={props?.onGesture ?? vi.fn()}
      />
    )
  })
}

function getScreen(height = 200): HTMLDivElement {
  const screen = container.querySelector<HTMLDivElement>('[aria-label="Emulator screen"]')
  if (!screen) {
    throw new Error('Emulator screen not rendered')
  }
  screen.getBoundingClientRect = () => new DOMRect(0, 0, 100, height)
  screen.setPointerCapture = vi.fn()
  return screen
}

function keyEvent(
  type: string,
  init: { altKey?: boolean; ctrlKey?: boolean; key: string; metaKey?: boolean; shiftKey?: boolean }
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    altKey: { value: init.altKey ?? false },
    ctrlKey: { value: init.ctrlKey ?? false },
    isComposing: { value: false },
    key: { value: init.key },
    metaKey: { value: init.metaKey ?? false },
    shiftKey: { value: init.shiftKey ?? false }
  })
  return event
}

function decodedSentMessages<T = unknown>(tag: number): T[] {
  return FakeWebSocket.instances
    .flatMap((ws) => ws.sent)
    .filter((frame) => frame[0] === tag)
    .map((frame) => JSON.parse(new TextDecoder().decode(frame.subarray(1))))
}

function decodedSentKeyboardFrames(): unknown[] {
  return decodedSentMessages(0x06)
}

function wheel(
  screen: HTMLDivElement,
  deltaY: number,
  clientY = 100,
  deltaMode = 0,
  deltaX = 0
): void {
  act(() => {
    const event = new Event('wheel', { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      clientX: { value: 50 },
      clientY: { value: clientY },
      deltaMode: { value: deltaMode },
      deltaX: { value: deltaX },
      deltaY: { value: deltaY }
    })
    screen.dispatchEvent(event)
  })
}

function finishWheel(): void {
  act(() => {
    vi.advanceTimersByTime(15_000)
  })
}

function wheelTravel(axis: 'x' | 'y' = 'y'): number {
  let previous = 0
  let travel = 0
  for (const point of decodedSentMessages<EmulatorGesturePoint>(0x03)) {
    if (point.type === 'move') {
      travel += previous - point[axis]
    }
    previous = point[axis]
    expect(point[axis]).toBeGreaterThanOrEqual(0.12)
    expect(point[axis]).toBeLessThanOrEqual(0.88)
  }
  return travel
}

describe('EmulatorDeviceFrame wheel scrolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    renderFrame()
    act(() => FakeWebSocket.instances[0]?.open())
  })

  it('defers isolated notch movement until after touch-down and spreads its travel across frames', () => {
    wheel(getScreen(), 2)
    expect(decodedSentMessages(0x03)).toEqual([{ type: 'begin', x: 0.5, y: 0.5 }])

    act(() => vi.advanceTimersByTime(16))
    expect(decodedSentMessages(0x03)).toEqual([
      { type: 'begin', x: 0.5, y: 0.5 },
      { type: 'move', x: 0.5, y: 0.4892 }
    ])
    finishWheel()
    expect(decodedSentMessages(0x03).slice(-3)).toEqual([
      { type: 'move', x: 0.5, y: expect.closeTo(0.4882, 10) },
      { type: 'move', x: 0.5, y: expect.closeTo(0.488, 10) },
      { type: 'end', x: 0.5, y: expect.closeTo(0.488, 10) }
    ])
    expect(wheelTravel()).toBeCloseTo(0.012)
  })

  it('never speeds up before lifting, so UIKit has no release velocity to fling from', () => {
    wheel(getScreen(), 10)
    finishWheel()
    const ys = decodedSentMessages<EmulatorGesturePoint>(0x03).map((point) => point.y)
    const steps = ys.slice(1).map((y, index) => ys[index]! - y)
    for (let index = 2; index < steps.length; index++) {
      expect(steps[index]).toBeLessThanOrEqual(steps[index - 1]! + 1e-12)
    }
    expect(wheelTravel()).toBeCloseTo(0.06)
  })

  it.each([
    { delta: 2, clientY: 0, start: 0.88, end: 0.868 },
    { delta: -2, clientY: 200, start: 0.12, end: 0.132 }
  ])('scrolls an isolated edge notch ($delta)', ({ delta, clientY, start, end }) => {
    wheel(getScreen(), delta, clientY)
    finishWheel()

    const touches = decodedSentMessages<EmulatorGesturePoint>(0x03)
    expect(touches.slice(0, 2)).toEqual([
      { type: 'begin', x: 0.5, y: start },
      { type: 'move', x: 0.5, y: expect.closeTo(delta > 0 ? 0.8692 : 0.1308) }
    ])
    expect(touches.at(-1)).toEqual({ type: 'end', x: 0.5, y: expect.closeTo(end) })
  })

  it.each([
    { delta: 50, distance: 0.9, edge: 0.12, restart: 0.88, end: 0.36 },
    { delta: -50, distance: -0.9, edge: 0.88, restart: 0.12, end: 0.64 }
  ])(
    'keeps all sustained scroll travel across the screen edge ($delta)',
    ({ delta, distance, edge, restart, end }) => {
      const screen = getScreen()
      for (let i = 0; i < 3; i++) {
        wheel(screen, delta)
        act(() => vi.advanceTimersByTime(80))
      }
      finishWheel()

      const touches = decodedSentMessages<EmulatorGesturePoint>(0x03)
      expect(wheelTravel()).toBeCloseTo(distance)
      expect(touches).toEqual(
        expect.arrayContaining([
          { type: 'end', x: 0.5, y: edge },
          { type: 'begin', x: 0.5, y: restart }
        ])
      )
      expect(touches.at(-1)).toEqual({ type: 'end', x: 0.5, y: expect.closeTo(end) })
    }
  )

  it('preserves small trackpad deltas rather than rounding them to mouse notches', () => {
    const screen = getScreen()
    wheel(screen, 1)
    act(() => vi.advanceTimersByTime(16))
    renderFrame({ onGesture: vi.fn() })
    wheel(screen, 1)
    finishWheel()

    expect(decodedSentMessages(0x03).slice(0, 3)).toEqual([
      { type: 'begin', x: 0.5, y: 0.5 },
      { type: 'move', x: 0.5, y: expect.closeTo(0.4946) },
      { type: 'move', x: 0.5, y: expect.closeTo(0.48866) }
    ])
    expect(wheelTravel()).toBeCloseTo(0.012)
    expect(decodedSentMessages<EmulatorGesturePoint>(0x03).at(-1)).toEqual({
      type: 'end',
      x: 0.5,
      y: expect.closeTo(0.488)
    })
  })

  it.each([
    { delta: 3, mode: 1, distance: 0.288 },
    { delta: 40, mode: 0, distance: 0.24 },
    { delta: 100, mode: 0, distance: 0.6 },
    { delta: 1000, mode: 0, distance: 6 }
  ])(
    'preserves the full mouse-wheel distance ($delta, mode $mode)',
    ({ delta, mode, distance }) => {
      wheel(getScreen(), delta, 100, mode)
      finishWheel()

      const touches = decodedSentMessages<EmulatorGesturePoint>(0x03)
      expect(wheelTravel()).toBeCloseTo(distance)
      expect(touches.at(-1)?.type).toBe('end')
    }
  )

  it.each([
    { count: 5, delta: 100, gap: 120, clientY: 500, distance: 0.6 },
    { count: 30, delta: 60, gap: 30, clientY: 950, distance: 2.16 },
    { count: 30, delta: -60, gap: 30, clientY: 120, distance: -2.16 }
  ])(
    'finishes fast wheel bursts promptly without dropping travel ($delta, $clientY)',
    ({ count, delta, gap, clientY, distance }) => {
      const screen = getScreen(1000)
      for (let i = 0; i < count; i++) {
        wheel(screen, delta, clientY)
        if (i < count - 1) {
          act(() => vi.advanceTimersByTime(gap))
        }
      }
      act(() => vi.advanceTimersByTime(350))

      const touches = decodedSentMessages<EmulatorGesturePoint>(0x03)
      expect(wheelTravel()).toBeCloseTo(distance)
      expect(touches.at(-1)?.type).toBe('end')
      act(() => vi.advanceTimersByTime(2000))
      expect(decodedSentMessages(0x03)).toEqual(touches)
    }
  )

  it('starts and restarts upward wheel scrolling below the iOS system status area', () => {
    wheel(getScreen(), -200, 10)
    finishWheel()

    const touches = decodedSentMessages<EmulatorGesturePoint>(0x03)
    expect(touches.filter((point) => point.type === 'begin')).toEqual([
      { type: 'begin', x: 0.5, y: 0.12 },
      { type: 'begin', x: 0.5, y: 0.12 }
    ])
    expect(touches).toContainEqual({ type: 'end', x: 0.5, y: 0.88 })
    expect(wheelTravel()).toBeCloseTo(-1.2)
    expect(touches.at(-1)).toEqual({ type: 'end', x: 0.5, y: expect.closeTo(0.56) })
  })

  it('preserves diagonal travel across both horizontal and vertical edge restarts', () => {
    wheel(getScreen(), 250, 100, 0, 250)
    finishWheel()

    expect(wheelTravel('x')).toBeCloseTo(3)
    expect(wheelTravel('y')).toBeCloseTo(1.5)
    expect(decodedSentMessages<EmulatorGesturePoint>(0x03).at(-1)?.type).toBe('end')
  })

  it('replays moving drags when the live control socket is unavailable', () => {
    const onGesture = vi.fn<(points: unknown[]) => void>()
    FakeWebSocket.instances[0]!.readyState = FakeWebSocket.CLOSED
    renderFrame({ onGesture })
    wheel(getScreen(), 1000)
    finishWheel()

    expect(onGesture.mock.calls[0]?.[0]).toEqual([
      { type: 'begin', x: 0.5, y: 0.5 },
      { type: 'move', x: 0.5, y: 0.31 },
      { type: 'end', x: 0.5, y: 0.12 }
    ])
    expect(onGesture.mock.calls[1]?.[0]).toEqual([
      { type: 'begin', x: 0.5, y: 0.88 },
      { type: 'move', x: 0.5, y: 0.5 },
      { type: 'end', x: 0.5, y: 0.12 }
    ])
    expect(decodedSentMessages(0x03)).toEqual([])
  })

  it('releases wheel playback before a pointer takes over the simulator finger', () => {
    const screen = getScreen()
    wheel(screen, 100)
    act(() => vi.advanceTimersByTime(16))
    const event = new PointerEvent('pointerdown', {
      bubbles: true,
      pointerId: 1,
      clientX: 50,
      clientY: 140
    })
    act(() => screen.dispatchEvent(event))
    finishWheel()

    expect(decodedSentMessages(0x03)).toEqual([
      { type: 'begin', x: 0.5, y: 0.5 },
      { type: 'move', x: 0.5, y: 0.488 },
      { type: 'end', x: 0.5, y: 0.488 },
      { type: 'begin', x: 0.5, y: 0.7 }
    ])
  })

  it.each(['disable', 'replace', 'reconnect'])(
    'cancels wheel playback on control-session %s',
    (mode) => {
      const onGesture = vi.fn()
      renderFrame({ onGesture })
      wheel(getScreen(), mode === 'reconnect' ? 10_000 : 100)
      act(() => vi.advanceTimersByTime(16))
      const before = decodedSentMessages<EmulatorGesturePoint>(0x03)
      expect(before.at(-1)?.type).toBe('move')
      if (mode === 'reconnect') {
        act(() => FakeWebSocket.instances[0]?.close())
        act(() => vi.advanceTimersByTime(750))
      } else {
        const wsUrl = mode === 'replace' ? 'ws://127.0.0.1:3101/ws' : undefined
        renderFrame({ onGesture, isLive: mode !== 'disable', wsUrl })
        if (mode === 'disable') {
          renderFrame({ onGesture })
        }
      }
      act(() => FakeWebSocket.instances.at(-1)?.open())
      finishWheel()
      act(() => root.render(<div />))
      expect(decodedSentMessages<EmulatorGesturePoint>(0x03).slice(before.length)).toEqual(
        mode === 'reconnect' ? [] : [{ type: 'end', x: 0.5, y: 0.488 }]
      )
      expect(onGesture).not.toHaveBeenCalled()
    }
  )

  it('preserves fallback travel split into sub-threshold boundary segments', () => {
    const onGesture = vi.fn<(points: EmulatorGesturePoint[]) => void>()
    FakeWebSocket.instances[0]!.readyState = FakeWebSocket.CLOSED
    renderFrame({ onGesture })
    wheel(getScreen(), 2, 25)
    finishWheel()
    expect(onGesture.mock.calls.map(([points]) => points.map(({ y }) => y))).toEqual([
      [0.125, 0.1225, 0.12],
      [0.88, expect.closeTo(0.8765), expect.closeTo(0.873)]
    ])
  })

  it('cancels queued movement when the frame is removed', () => {
    wheel(getScreen(), 100)
    act(() => root.render(<div />))
    finishWheel()

    expect(decodedSentMessages(0x03)).toEqual([
      { type: 'begin', x: 0.5, y: 0.5 },
      { type: 'end', x: 0.5, y: 0.5 }
    ])
  })
})

describe('EmulatorDeviceFrame input', () => {
  it('releases pressed keyboard usages when delayed frames are canceled by cleanup', () => {
    vi.useFakeTimers()
    renderFrame()
    act(() => {
      FakeWebSocket.instances[0]?.open()
    })
    const screen = getScreen()

    act(() => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
      screen.dispatchEvent(keyEvent('keydown', { key: 'A' }))
    })

    expect(decodedSentKeyboardFrames()).toEqual([{ type: 'down', usage: 225 }])

    act(() => {
      root.render(<div />)
    })

    expect(decodedSentKeyboardFrames()).toEqual([
      { type: 'down', usage: 225 },
      { type: 'up', usage: 225 }
    ])
  })
})
