// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmulatorDeviceFrame } from './emulator-device-frame'

type PointerInit = {
  button?: number
  clientX: number
  clientY: number
  pointerId?: number
}

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
  onGesture?: (points: unknown[]) => void
  onTap?: (x: number, y: number) => void
}): void {
  act(() => {
    root.render(
      <EmulatorDeviceFrame
        previewUrl="http://127.0.0.1:3100/stream.mjpeg"
        wsUrl="ws://127.0.0.1:3100/ws"
        loading={false}
        isLive={true}
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
  screen.getBoundingClientRect = () =>
    ({
      bottom: 200,
      height: 200,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({})
    }) as DOMRect
  screen.setPointerCapture = vi.fn()
  return screen
}

function pointerEvent(type: string, init: PointerInit): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    button: { value: init.button ?? 0 },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    pointerId: { value: init.pointerId ?? 1 }
  })
  return event
}

function wheelEvent(init: {
  clientX: number
  clientY: number
  deltaX: number
  deltaY: number
}): Event {
  const event = new Event('wheel', { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    deltaMode: { value: 0 },
    deltaX: { value: init.deltaX },
    deltaY: { value: init.deltaY }
  })
  return event
}

function decodedSentTouches(): unknown[] {
  const ws = FakeWebSocket.instances[0]
  if (!ws) {
    return []
  }
  return ws.sent.map((frame) => {
    expect(frame[0]).toBe(0x03)
    return JSON.parse(new TextDecoder().decode(frame.subarray(1)))
  })
}

describe('EmulatorDeviceFrame input', () => {
  it('streams pointer drag phases directly to serve-sim', () => {
    const onGesture = vi.fn()
    renderFrame({ onGesture })
    act(() => {
      FakeWebSocket.instances[0]?.open()
    })
    const screen = getScreen()

    act(() => {
      screen.dispatchEvent(pointerEvent('pointerdown', { clientX: 50, clientY: 160 }))
      screen.dispatchEvent(pointerEvent('pointermove', { clientX: 50, clientY: 100 }))
      screen.dispatchEvent(pointerEvent('pointerup', { clientX: 50, clientY: 40 }))
    })

    expect(decodedSentTouches()).toEqual([
      { type: 'begin', x: 0.5, y: 0.8 },
      { type: 'move', x: 0.5, y: 0.5 },
      { type: 'end', x: 0.5, y: 0.2 }
    ])
    expect(onGesture).not.toHaveBeenCalled()
  })

  it('turns trackpad wheel input into a live touch scroll', () => {
    vi.useFakeTimers()
    renderFrame()
    act(() => {
      FakeWebSocket.instances[0]?.open()
    })
    const screen = getScreen()

    act(() => {
      screen.dispatchEvent(wheelEvent({ clientX: 50, clientY: 100, deltaX: 0, deltaY: 80 }))
    })

    expect(decodedSentTouches()).toEqual([
      { type: 'begin', x: 0.5, y: 0.5 },
      { type: 'move', x: 0.5, y: 0.020000000000000018 }
    ])

    act(() => {
      vi.advanceTimersByTime(80)
    })

    expect(decodedSentTouches()).toEqual([
      { type: 'begin', x: 0.5, y: 0.5 },
      { type: 'move', x: 0.5, y: 0.020000000000000018 },
      { type: 'end', x: 0.5, y: 0.020000000000000018 }
    ])
  })
})
