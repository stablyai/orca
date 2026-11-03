// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { EMULATOR_KEYBOARD_PASTE_MAX_BYTES } from './emulator-keyboard-paste'
import { EmulatorDeviceFrame } from './emulator-device-frame'
import type {
  EmulatorControlApi,
  EmulatorControlStreamStatus
} from '../../../../shared/emulator-control-stream'
import type { EmulatorVideoApi } from '../../../../shared/emulator-video-stream'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

type PointerInit = {
  button?: number
  clientX: number
  clientY: number
  pointerId?: number
}

type FrameListener = (frame: { streamId: string; bytes: ArrayBuffer }) => void

const videoApi: EmulatorVideoApi = {
  startVideoStream: async ({ streamId }) => ({ streamId }),
  stopVideoStream: async () => {},
  onVideoStreamMeta: () => () => {},
  onVideoStreamFrame: () => () => {}
}

class FakeControlApi implements EmulatorControlApi {
  readonly statusListeners = new Set<(status: EmulatorControlStreamStatus) => void>()
  readonly startControlStream = vi.fn<EmulatorControlApi['startControlStream']>(async () => {})
  readonly sendControlFrame = vi.fn<EmulatorControlApi['sendControlFrame']>()
  readonly stopControlStream = vi.fn<EmulatorControlApi['stopControlStream']>()

  onControlStreamStatus(callback: (status: EmulatorControlStreamStatus) => void): () => void {
    this.statusListeners.add(callback)
    return () => {
      this.statusListeners.delete(callback)
    }
  }

  emitStatus(status: EmulatorControlStreamStatus): void {
    for (const listener of this.statusListeners) {
      listener(status)
    }
  }
}

let container: HTMLDivElement
let root: Root
let controlApi: FakeControlApi

beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  controlApi = new FakeControlApi()
  vi.stubGlobal('api', { emulator: controlApi })
  vi.stubGlobal('WebSocket', vi.fn())
  vi.stubGlobal(
    'VideoDecoder',
    class {
      state = 'unconfigured'

      close(): void {
        this.state = 'closed'
      }
    }
  )
  vi.stubGlobal('EncodedVideoChunk', class {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
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
  vi.restoreAllMocks()
})

function renderFrame(props?: {
  onGesture?: (points: unknown[]) => void
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
        isLive={true}
        visualOrientation="portrait"
        isActive={true}
        onTap={props?.onTap ?? vi.fn()}
        onGesture={props?.onGesture ?? vi.fn()}
      />
    )
  })
}

function connectControlStream(index = 0): string {
  const start = controlApi.startControlStream.mock.calls[index]?.[0]
  if (!start) {
    throw new Error(`Control stream ${index} was not started`)
  }
  act(() => {
    controlApi.emitStatus({ streamId: start.streamId, connected: true })
  })
  return start.streamId
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

function pasteEvent(text: string): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: vi.fn((type: string) => (type === 'text' ? text : ''))
    }
  })
  return event
}

function decodedSentMessages(tag: number): unknown[] {
  return controlApi.sendControlFrame.mock.calls
    .map(([{ bytes }]) => bytes)
    .filter((frame) => frame[0] === tag)
    .map((frame) => JSON.parse(new TextDecoder().decode(frame.subarray(1))))
}

function decodedSentTouches(): unknown[] {
  return decodedSentMessages(0x03)
}

function decodedSentKeyboardFrames(): unknown[] {
  return decodedSentMessages(0x06)
}

describe('EmulatorDeviceFrame input', () => {
  it('streams a live drag before pointerup when connected status precedes start completion', () => {
    controlApi.startControlStream.mockReturnValueOnce(new Promise<void>(() => {}))
    const onGesture = vi.fn()
    renderFrame({ onGesture })
    connectControlStream()
    const screen = getScreen()

    act(() => {
      screen.dispatchEvent(pointerEvent('pointerdown', { clientX: 50, clientY: 160 }))
      screen.dispatchEvent(pointerEvent('pointermove', { clientX: 50, clientY: 100 }))
    })

    expect(decodedSentTouches()).toEqual([
      { type: 'begin', x: 0.5, y: 0.8 },
      { type: 'move', x: 0.5, y: 0.5 }
    ])
    expect(onGesture).not.toHaveBeenCalled()

    act(() => {
      screen.dispatchEvent(pointerEvent('pointerup', { clientX: 50, clientY: 40 }))
    })

    expect(decodedSentTouches()).toEqual([
      { type: 'begin', x: 0.5, y: 0.8 },
      { type: 'move', x: 0.5, y: 0.5 },
      { type: 'end', x: 0.5, y: 0.2 }
    ])
    expect(onGesture).not.toHaveBeenCalled()
    expect(WebSocket).not.toHaveBeenCalled()
  })

  it('reconnects after 750ms without stale statuses interrupting live input or replaying delayed keys', () => {
    vi.useFakeTimers()
    const onGesture = vi.fn()
    renderFrame({ onGesture })
    const oldStreamId = connectControlStream()
    const screen = getScreen()

    act(() => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
      screen.dispatchEvent(keyEvent('keydown', { key: 'A' }))
      controlApi.emitStatus({ streamId: oldStreamId, connected: false })
      vi.advanceTimersByTime(749)
    })

    expect(controlApi.startControlStream).toHaveBeenCalledTimes(1)
    expect(decodedSentKeyboardFrames()).toEqual([{ type: 'down', usage: 225 }])

    act(() => {
      vi.advanceTimersByTime(1)
    })
    const streamId = connectControlStream(1)
    expect(streamId).not.toBe(oldStreamId)
    expect(decodedSentKeyboardFrames()).toEqual([
      { type: 'down', usage: 225 },
      { type: 'up', usage: 225 }
    ])

    act(() => {
      controlApi.emitStatus({ streamId: oldStreamId, connected: false })
      controlApi.emitStatus({ streamId: oldStreamId, connected: true })
      screen.dispatchEvent(pointerEvent('pointerdown', { clientX: 50, clientY: 160 }))
      screen.dispatchEvent(pointerEvent('pointermove', { clientX: 50, clientY: 100 }))
    })

    expect(decodedSentTouches()).toEqual([
      { type: 'begin', x: 0.5, y: 0.8 },
      { type: 'move', x: 0.5, y: 0.5 }
    ])

    act(() => {
      screen.dispatchEvent(pointerEvent('pointerup', { clientX: 50, clientY: 40 }))
      vi.advanceTimersByTime(750)
    })

    expect(decodedSentTouches()).toEqual([
      { type: 'begin', x: 0.5, y: 0.8 },
      { type: 'move', x: 0.5, y: 0.5 },
      { type: 'end', x: 0.5, y: 0.2 }
    ])
    expect(
      controlApi.sendControlFrame.mock.calls
        .filter(([{ bytes }]) => bytes[0] === 0x03)
        .map(([frame]) => frame.streamId)
    ).toEqual([streamId, streamId, streamId])
    expect(controlApi.startControlStream).toHaveBeenCalledTimes(2)
    expect(decodedSentKeyboardFrames()).toEqual([
      { type: 'down', usage: 225 },
      { type: 'up', usage: 225 }
    ])
    expect(onGesture).not.toHaveBeenCalled()
  })

  it('rotates live touch coordinates on metadata updates without releasing a held Shift', async () => {
    vi.useFakeTimers()
    let frameListener: FrameListener | undefined
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL(): string {
          return 'blob:orientation-frame'
        }

        static override revokeObjectURL(): void {}
      }
    )
    Object.assign(controlApi, {
      startFrameStream: async () => ({ streamId: 'orientation-frames' }),
      stopFrameStream: async () => {},
      onFrameStreamFrame: (listener: FrameListener) => {
        frameListener = listener
        return () => {
          frameListener = undefined
        }
      },
      onFrameStreamError: () => () => {}
    })
    renderFrame()
    await act(async () => {
      await Promise.resolve()
    })
    const streamId = connectControlStream()
    act(() => {
      frameListener?.({
        streamId: 'orientation-frames',
        bytes: new Uint8Array([1, 2, 3]).buffer
      })
    })
    const image = container.querySelector('img')
    if (!image) {
      throw new Error('Emulator frame not rendered')
    }
    Object.defineProperties(image, {
      naturalWidth: { value: 100 },
      naturalHeight: { value: 200 }
    })
    act(() => {
      image.dispatchEvent(new Event('load'))
    })
    const screen = getScreen()
    act(() => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
      screen.dispatchEvent(keyEvent('keydown', { key: 'A' }))
    })
    expect(decodedSentKeyboardFrames()).toEqual([{ type: 'down', usage: 225 }])

    act(() => {
      controlApi.emitStatus({ streamId, connected: true, orientation: 'landscape_left' })
    })
    act(() => {
      screen.dispatchEvent(pointerEvent('pointerdown', { clientX: 75, clientY: 87.5 }))
      screen.dispatchEvent(pointerEvent('pointerup', { clientX: 25, clientY: 112.5 }))
    })

    expect(decodedSentTouches()).toEqual([
      { type: 'begin', x: 0.25, y: 0.25 },
      { type: 'end', x: 0.75, y: 0.75 }
    ])
    expect(decodedSentKeyboardFrames()).toEqual([{ type: 'down', usage: 225 }])
    act(() => {
      vi.advanceTimersByTime(12)
    })
    expect(decodedSentKeyboardFrames()).toEqual([
      { type: 'down', usage: 225 },
      { type: 'down', usage: 4 },
      { type: 'up', usage: 4 },
      { type: 'up', usage: 225 }
    ])
    expect(controlApi.startControlStream).toHaveBeenCalledOnce()
    expect(WebSocket).not.toHaveBeenCalled()
  })

  it('keeps lost key-up recovery available across repeated reconnect failures', () => {
    vi.useFakeTimers()
    renderFrame()
    const streamId = connectControlStream()
    const screen = getScreen()

    act(() => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
      screen.dispatchEvent(keyEvent('keydown', { key: 'A' }))
      vi.advanceTimersByTime(12)
    })
    expect(decodedSentKeyboardFrames()).toEqual([
      { type: 'down', usage: 225 },
      { type: 'down', usage: 4 },
      { type: 'up', usage: 4 },
      { type: 'up', usage: 225 }
    ])

    act(() => {
      controlApi.emitStatus({
        streamId,
        connected: false,
        pressedKeyboardUsages: [225, 4]
      })
      vi.advanceTimersByTime(750)
    })
    const retryId = connectControlStream(1)

    expect(decodedSentKeyboardFrames().slice(4)).toEqual([
      { type: 'up', usage: 4 },
      { type: 'up', usage: 225 }
    ])

    act(() => {
      controlApi.emitStatus({
        streamId: retryId,
        connected: false,
        pressedKeyboardUsages: controlApi.startControlStream.mock.calls[1][0].pressedKeyboardUsages
      })
      vi.advanceTimersByTime(750)
    })
    connectControlStream(2)
    expect(decodedSentKeyboardFrames().slice(6)).toEqual([
      { type: 'up', usage: 4 },
      { type: 'up', usage: 225 }
    ])
  })

  it('retries a failed control start after 750ms and waits for connected status before sending keys', async () => {
    vi.useFakeTimers()
    controlApi.startControlStream.mockRejectedValueOnce(new Error('Control stream failed to start'))
    renderFrame()
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      vi.advanceTimersByTime(749)
    })
    expect(controlApi.startControlStream).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
    })
    expect(controlApi.startControlStream).toHaveBeenCalledTimes(2)

    const screen = getScreen()
    act(() => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
      screen.dispatchEvent(keyEvent('keydown', { key: 'a' }))
    })
    expect(decodedSentKeyboardFrames()).toEqual([])

    connectControlStream(1)
    act(() => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'b' }))
    })
    expect(decodedSentKeyboardFrames()).toEqual([{ type: 'down', usage: 5 }])

    act(() => {
      vi.advanceTimersByTime(4)
    })
    expect(decodedSentKeyboardFrames()).toEqual([
      { type: 'down', usage: 5 },
      { type: 'up', usage: 5 }
    ])
  })

  it('streams Android pointer phases to main for the scrcpy control socket', () => {
    const sendScrcpyTouch = vi.fn()
    vi.stubGlobal('api', { emulator: { ...videoApi, sendScrcpyTouch } })
    const onGesture = vi.fn()
    const onTap = vi.fn()
    renderFrame({ onGesture, onTap, previewUrl: 'scrcpy://serial-1', wsUrl: '' })
    const screen = getScreen()

    act(() => {
      screen.dispatchEvent(pointerEvent('pointerdown', { clientX: 50, clientY: 160 }))
      screen.dispatchEvent(pointerEvent('pointermove', { clientX: 50, clientY: 100 }))
      screen.dispatchEvent(pointerEvent('pointerup', { clientX: 50, clientY: 40 }))
    })

    expect(sendScrcpyTouch.mock.calls.map(([touch]) => touch)).toEqual([
      { deviceId: 'serial-1', type: 'begin', x: 0.5, y: 0.8 },
      { deviceId: 'serial-1', type: 'move', x: 0.5, y: 0.5 },
      { deviceId: 'serial-1', type: 'end', x: 0.5, y: 0.2 }
    ])
    expect(onGesture).not.toHaveBeenCalled()
    expect(onTap).not.toHaveBeenCalled()
    expect(WebSocket).not.toHaveBeenCalled()
  })

  it('marks bottom-origin pointer drags as serve-sim edge gestures', () => {
    renderFrame()
    connectControlStream()
    const screen = getScreen()

    act(() => {
      screen.dispatchEvent(pointerEvent('pointerdown', { clientX: 50, clientY: 196 }))
      screen.dispatchEvent(pointerEvent('pointermove', { clientX: 50, clientY: 120 }))
      screen.dispatchEvent(pointerEvent('pointerup', { clientX: 50, clientY: 40 }))
    })

    expect(decodedSentTouches()).toEqual([
      { type: 'begin', x: 0.5, y: 0.98, edge: 3 },
      { type: 'move', x: 0.5, y: 0.6, edge: 3 },
      { type: 'end', x: 0.5, y: 0.2, edge: 3 }
    ])
  })

  it('forwards focused keyboard text as serve-sim HID frames', () => {
    vi.useFakeTimers()
    renderFrame()
    connectControlStream()
    const screen = getScreen()

    act(() => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
      screen.dispatchEvent(keyEvent('keydown', { key: 'A' }))
    })

    expect(decodedSentKeyboardFrames()).toEqual([{ type: 'down', usage: 225 }])

    act(() => {
      vi.advanceTimersByTime(12)
    })

    expect(decodedSentKeyboardFrames()).toEqual([
      { type: 'down', usage: 225 },
      { type: 'down', usage: 4 },
      { type: 'up', usage: 4 },
      { type: 'up', usage: 225 }
    ])
  })

  it('forwards focused paste text as bounded serve-sim HID frames', () => {
    vi.useFakeTimers()
    renderFrame()
    connectControlStream()
    const screen = getScreen()
    const paste = pasteEvent('ab')

    act(() => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
      screen.dispatchEvent(paste)
    })

    expect(paste.defaultPrevented).toBe(true)
    expect(decodedSentKeyboardFrames()).toEqual([{ type: 'down', usage: 4 }])

    act(() => {
      vi.advanceTimersByTime(12)
    })

    expect(decodedSentKeyboardFrames()).toEqual([
      { type: 'down', usage: 4 },
      { type: 'up', usage: 4 },
      { type: 'down', usage: 5 },
      { type: 'up', usage: 5 }
    ])
  })

  it('sends Android keys and paste to the scrcpy control socket in order', async () => {
    vi.mocked(toast.error).mockClear()
    const sendScrcpyKeyboard = vi.fn<Window['api']['emulator']['sendScrcpyKeyboard']>(
      async () => true
    )
    vi.stubGlobal('api', { emulator: { ...videoApi, sendScrcpyKeyboard } })
    renderFrame({ previewUrl: 'scrcpy://serial-1', wsUrl: '' })
    const screen = getScreen()
    const paste = pasteEvent('hi\r\nyou')

    await act(async () => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
      screen.dispatchEvent(keyEvent('keydown', { key: 'a' }))
      screen.dispatchEvent(keyEvent('keydown', { key: 'ArrowLeft', shiftKey: true }))
      screen.dispatchEvent(paste)
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
    })

    expect(paste.defaultPrevented).toBe(true)
    expect(sendScrcpyKeyboard.mock.calls.map(([input]) => input)).toEqual([
      { deviceId: 'serial-1', text: 'a' },
      { deviceId: 'serial-1', key: 'dpad_left', shift: true },
      { deviceId: 'serial-1', text: 'hi\nyou' },
      { deviceId: 'serial-1', key: 'enter', shift: false }
    ])
    expect(toast.error).not.toHaveBeenCalled()
    expect(WebSocket).not.toHaveBeenCalled()
  })

  it('rejects oversized screen paste without scheduling keyboard frames', async () => {
    renderFrame()
    connectControlStream()
    const screen = getScreen()
    const paste = pasteEvent('a'.repeat(EMULATOR_KEYBOARD_PASTE_MAX_BYTES + 1))

    await act(async () => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
      screen.dispatchEvent(paste)
      await Promise.resolve()
    })

    expect(paste.defaultPrevented).toBe(true)
    expect(decodedSentKeyboardFrames()).toEqual([])
    expect(toast.error).toHaveBeenCalledWith('Paste is too large for emulator keyboard input.')
  })

  it('releases held keys before stopping control and cancels delayed frames on unmount', () => {
    vi.useFakeTimers()
    renderFrame()
    const streamId = connectControlStream()
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
    expect(controlApi.stopControlStream).toHaveBeenCalledWith({ streamId })
    expect(controlApi.sendControlFrame.mock.invocationCallOrder[1]).toBeLessThan(
      controlApi.stopControlStream.mock.invocationCallOrder[0]
    )
    expect(controlApi.statusListeners.size).toBe(0)

    act(() => {
      controlApi.emitStatus({ streamId, connected: false })
      vi.advanceTimersByTime(750)
    })

    expect(controlApi.startControlStream).toHaveBeenCalledTimes(1)
    expect(decodedSentKeyboardFrames()).toEqual([
      { type: 'down', usage: 225 },
      { type: 'up', usage: 225 }
    ])
  })

  it('does not trap Tab focus until keyboard capture is explicitly active', () => {
    vi.useFakeTimers()
    renderFrame()
    connectControlStream()
    const screen = getScreen()
    expect(screen.getAttribute('role')).toBe('application')

    const tabBeforeCapture = keyEvent('keydown', { key: 'Tab' })
    act(() => {
      screen.dispatchEvent(tabBeforeCapture)
    })

    expect(tabBeforeCapture.defaultPrevented).toBe(false)
    expect(decodedSentKeyboardFrames()).toEqual([])

    const enterCapture = keyEvent('keydown', { key: 'Enter' })
    const tabDuringCapture = keyEvent('keydown', { key: 'Tab', shiftKey: true })
    act(() => {
      screen.dispatchEvent(enterCapture)
      screen.dispatchEvent(tabDuringCapture)
    })

    expect(enterCapture.defaultPrevented).toBe(true)
    expect(tabDuringCapture.defaultPrevented).toBe(true)

    act(() => {
      vi.advanceTimersByTime(12)
    })

    expect(decodedSentKeyboardFrames()).toEqual([
      { type: 'down', usage: 225 },
      { type: 'down', usage: 43 },
      { type: 'up', usage: 43 },
      { type: 'up', usage: 225 }
    ])

    const escapeCapture = keyEvent('keydown', { key: 'Escape' })
    const tabAfterEscape = keyEvent('keydown', { key: 'Tab' })
    act(() => {
      screen.dispatchEvent(escapeCapture)
      screen.dispatchEvent(tabAfterEscape)
    })

    expect(escapeCapture.defaultPrevented).toBe(true)
    expect(tabAfterEscape.defaultPrevented).toBe(false)
  })

  it('leaves host modifier shortcuts alone while focused', () => {
    renderFrame()
    connectControlStream()
    const screen = getScreen()

    act(() => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'p', metaKey: true }))
      screen.dispatchEvent(keyEvent('keydown', { key: 'p', ctrlKey: true }))
    })

    expect(decodedSentKeyboardFrames()).toEqual([])
  })

  it('turns trackpad wheel input into a live touch scroll', () => {
    vi.useFakeTimers()
    renderFrame()
    connectControlStream()
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
