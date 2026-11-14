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

function getScreen(): HTMLDivElement {
  const screen = container.querySelector<HTMLDivElement>('[aria-label="Emulator screen"]')
  if (!screen) {
    throw new Error('Emulator screen not rendered')
  }
  screen.getBoundingClientRect = () => new DOMRect(0, 0, 100, 200)
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

function wheel(screen: HTMLDivElement, deltaY: number): void {
  act(() => {
    const event = new Event('wheel', { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      clientX: { value: 50 },
      clientY: { value: 100 },
      deltaMode: { value: 0 },
      deltaX: { value: 0 },
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

function wheelTravel(): number {
  let previous = 0
  let travel = 0
  for (const point of decodedSentMessages<EmulatorGesturePoint>(0x03)) {
    if (point.type === 'move') {
      travel += previous - point.y
    }
    previous = point.y
    expect(point.y).toBeGreaterThanOrEqual(0.12)
    expect(point.y).toBeLessThanOrEqual(0.88)
  }
  return travel
}

describe('EmulatorDeviceFrame wheel scrolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    renderFrame()
    act(() => FakeWebSocket.instances[0]?.open())
  })

  it('waits a frame after touch-down before moving an isolated notch, then travels its full distance', () => {
    wheel(getScreen(), 2)
    expect(decodedSentMessages(0x03)).toEqual([{ type: 'begin', x: 0.5, y: 0.5 }])

    finishWheel()
    expect(wheelTravel()).toBeCloseTo(0.012)
    expect(decodedSentMessages<EmulatorGesturePoint>(0x03).at(-1)?.type).toBe('end')
  })

  it.each([
    { delta: 50, distance: 0.9, edge: 0.12, restart: 0.88 },
    { delta: -50, distance: -0.9, edge: 0.88, restart: 0.12 }
  ])(
    'keeps all sustained scroll travel across the screen edge ($delta)',
    ({ delta, distance, edge, restart }) => {
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
      expect(touches.at(-1)?.type).toBe('end')
    }
  )

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

    const touches = decodedSentMessages<EmulatorGesturePoint>(0x03)
    expect(touches.map(({ type }) => type)).toEqual(['begin', 'move', 'end', 'begin'])
    expect(touches[2]).toEqual({ ...touches[1], type: 'end' })
    expect(touches[3]).toEqual({ type: 'begin', x: 0.5, y: 0.7 })
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
        mode === 'reconnect' ? [] : [{ ...before.at(-1), type: 'end' }]
      )
      expect(onGesture).not.toHaveBeenCalled()
    }
  )

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
