// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmulatorControlStreamEvent } from '../../../../preload/api/emulator-api'
import { useEmulatorControlStream } from './use-emulator-control-stream'

import { EmulatorDeviceFrame } from './emulator-device-frame'
import type { EmulatorGesturePoint } from './emulator-screen-gesture'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

const streams: { streamId: string; wsUrl: string; sent: Uint8Array[]; closed: boolean }[] = []
const listeners = new Set<(event: EmulatorControlStreamEvent) => void>()

function emit(type: EmulatorControlStreamEvent['type'], data?: ArrayBuffer | string): void {
  const streamId = streams.at(-1)?.streamId
  if (streamId) {
    for (const listener of listeners) {
      listener({ streamId, type, data })
    }
  }
}

function ControlStatus({ enabled = true }: { enabled?: boolean }) {
  const stream = useEmulatorControlStream('ws://127.0.0.1:3100/ws', enabled)
  return (
    <button onClick={() => stream.sendTouch({ type: 'begin', x: 0.25, y: 0.75 })}>
      {`${stream.connected}:${stream.reportedOrientation}`}
    </button>
  )
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  streams.length = 0
  listeners.clear()
  vi.stubGlobal('api', {
    ...window.api,
    emulator: {
      ...window.api?.emulator,
      startControlStream: ({ streamId, wsUrl }: { streamId: string; wsUrl: string }) => {
        streams.push({ streamId, wsUrl, sent: [], closed: false })
        return Promise.resolve()
      },
      stopControlStream: ({ streamId }: { streamId: string }) => {
        const stream = streams.find((stream) => stream.streamId === streamId)
        if (stream) {
          stream.closed = true
        }
        return Promise.resolve()
      },
      sendControlStream: ({ streamId, data }: { streamId: string; data: Uint8Array }) =>
        streams.find((stream) => stream.streamId === streamId)?.sent.push(data),
      onControlStreamEvent: (listener: (event: EmulatorControlStreamEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  })
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
  return streams
    .flatMap((stream) => stream.sent)
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
    act(() => emit('open'))
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
        act(() => emit('close'))
        act(() => vi.advanceTimersByTime(750))
      } else {
        const wsUrl = mode === 'replace' ? 'ws://127.0.0.1:3101/ws' : undefined
        renderFrame({ onGesture, isLive: mode !== 'disable', wsUrl })
        if (mode === 'disable') {
          renderFrame({ onGesture })
        }
      }
      act(() => emit('open'))
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
      emit('open')
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
    expect(streams[0]?.closed).toBe(true)
  })

  it('keeps helper orientation across reconnects and releases a disabled stream', () => {
    vi.useFakeTimers()
    act(() => root.render(<ControlStatus />))
    expect(container.textContent).toBe('false:null')
    act(() => emit('open'))
    act(() => container.querySelector('button')?.click())
    expect(decodedSentMessages(0x03)).toEqual([{ type: 'begin', x: 0.25, y: 0.75 }])
    const config = new TextEncoder().encode(JSON.stringify({ orientation: 'landscape_left' }))
    const message = new Uint8Array(config.length + 1)
    message[0] = 130
    message.set(config, 1)
    act(() => emit('message', message.buffer))
    expect(container.textContent).toBe('true:landscape_left')
    act(() => emit('error', 'disconnected'))
    expect(container.textContent).toBe('false:landscape_left')
    act(() => vi.advanceTimersByTime(750))
    act(() => emit('open'))
    expect(container.textContent).toBe('true:landscape_left')
    act(() => root.render(<ControlStatus enabled={false} />))
    expect(container.textContent).toBe('false:landscape_left')
    expect(streams.at(-1)?.closed).toBe(true)
  })
})
