// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EmulatorDeviceFrame } from './emulator-device-frame'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

const callRuntimeRpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))

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
  vi.stubGlobal('api', { app: { onKeyboardLayoutChanged: () => () => undefined } })
  callRuntimeRpc.mockReset().mockResolvedValue({ physicalKeys: false })
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

function renderFrame(): void {
  act(() => {
    root.render(
      <EmulatorDeviceFrame
        worktreeId="wt-1"
        previewUrl="http://127.0.0.1:3100/stream.mjpeg"
        wsUrl="ws://127.0.0.1:3100/ws"
        loading={false}
        isLive={true}
        visualOrientation="portrait"
        isActive={true}
        onTap={vi.fn()}
        onGesture={vi.fn()}
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
  init: {
    altKey?: boolean
    capsLock?: boolean
    code?: string
    ctrlKey?: boolean
    isComposing?: boolean
    key: string
    metaKey?: boolean
    shiftKey?: boolean
  }
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    altKey: { value: init.altKey ?? false },
    code: { value: init.code ?? '' },
    getModifierState: { value: (key: string) => key === 'CapsLock' && init.capsLock === true },
    ctrlKey: { value: init.ctrlKey ?? false },
    isComposing: { value: init.isComposing ?? false },
    keyCode: { value: init.isComposing ? 229 : 0 },
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

describe('EmulatorDeviceFrame wheel scrolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    renderFrame()
    act(() => FakeWebSocket.instances[0]?.open())
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
  it('releases pressed keyboard usages when delayed frames are canceled by cleanup', async () => {
    vi.useFakeTimers()
    renderFrame()
    act(() => {
      FakeWebSocket.instances[0]?.open()
    })
    const screen = getScreen()

    await act(async () => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
    })
    act(() => {
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

  it('sends the physical key once the simulator follows the Mac keyboard layout', async () => {
    vi.useFakeTimers()
    let finishSync: (result: { physicalKeys: boolean }) => void = () => {}
    callRuntimeRpc.mockReturnValue(new Promise((resolve) => (finishSync = resolve)))
    renderFrame()
    act(() => {
      FakeWebSocket.instances[0]?.open()
    })
    const screen = getScreen()

    // Turkish Q: the key right of L types "ş" ("Ş" with Caps Lock), Option+Q types "@".
    act(() => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
      screen.dispatchEvent(keyEvent('keydown', { code: 'Semicolon', key: 'ş' }))
    })
    // A key typed before the layout sync lands waits for it instead of using the old layout.
    expect(decodedSentKeyboardFrames()).toEqual([])
    await act(async () => {
      finishSync({ physicalKeys: true })
    })
    act(() => {
      vi.runAllTimers()
      screen.dispatchEvent(keyEvent('keydown', { altKey: true, code: 'KeyQ', key: '@' }))
      vi.runAllTimers()
      screen.dispatchEvent(keyEvent('keydown', { capsLock: true, code: 'Semicolon', key: 'Ş' }))
      vi.runAllTimers()
    })

    expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'emulator.syncKeyboardLayout', {
      worktree: 'wt-1'
    })
    expect(decodedSentKeyboardFrames()).toEqual([
      { type: 'down', usage: 0x33 },
      { type: 'up', usage: 0x33 },
      { type: 'down', usage: 0xe2 },
      { type: 'down', usage: 0x14 },
      { type: 'up', usage: 0x14 },
      { type: 'up', usage: 0xe2 },
      { type: 'down', usage: 0xe1 },
      { type: 'down', usage: 0x33 },
      { type: 'up', usage: 0x33 },
      { type: 'up', usage: 0xe1 }
    ])
  })

  it('types text a Mac input method composed, then the keys typed after it', async () => {
    vi.useFakeTimers()
    renderFrame()
    act(() => {
      FakeWebSocket.instances[0]?.open()
    })
    const screen = getScreen()
    const proxy = screen.querySelector<HTMLTextAreaElement>('[data-emulator-keyboard-proxy]')!
    await act(async () => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
    })
    let finishType: () => void = () => {}
    callRuntimeRpc.mockReturnValue(new Promise<void>((resolve) => (finishType = resolve)))

    // Pinyin: keys spent composing reach neither the simulator nor anything but the proxy.
    const composingKey = keyEvent('keydown', { code: 'KeyN', isComposing: true, key: 'n' })
    act(() => {
      proxy.dispatchEvent(composingKey)
      proxy.value = '你好'
      proxy.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }))
      // Space right after the commit must not land before the composed text.
      proxy.dispatchEvent(keyEvent('keydown', { code: 'Space', key: ' ' }))
      // Punctuation committed while the first commit is in flight goes as one commit.
      for (const mark of ['，', '。']) {
        proxy.value = mark
        proxy.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false }))
      }
      vi.runAllTimers()
    })
    expect(composingKey.defaultPrevented).toBe(false)
    expect(proxy.value).toBe('')
    expect(callRuntimeRpc).toHaveBeenLastCalledWith({ kind: 'local' }, 'emulator.type', {
      text: '你好',
      worktree: 'wt-1'
    })
    expect(decodedSentKeyboardFrames()).toEqual([])

    callRuntimeRpc.mockResolvedValue(undefined)
    await act(async () => {
      finishType()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(decodedSentKeyboardFrames()).toEqual([
      { type: 'down', usage: 0x2c },
      { type: 'up', usage: 0x2c }
    ])
    expect(callRuntimeRpc).toHaveBeenLastCalledWith({ kind: 'local' }, 'emulator.type', {
      text: '，。',
      worktree: 'wt-1'
    })
  })

  it('leaves dead keys to a simulator that follows the Mac layout', async () => {
    vi.useFakeTimers()
    callRuntimeRpc.mockResolvedValue({ physicalKeys: true })
    renderFrame()
    act(() => {
      FakeWebSocket.instances[0]?.open()
    })
    const screen = getScreen()
    const proxy = screen.querySelector<HTMLTextAreaElement>('[data-emulator-keyboard-proxy]')!
    await act(async () => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
    })

    // Option+E then E: the simulator composes "é" from the physical keys, so the Mac's "é" is dropped.
    act(() => {
      proxy.dispatchEvent(keyEvent('keydown', { altKey: true, code: 'KeyE', key: 'Dead' }))
      vi.runAllTimers()
      proxy.dispatchEvent(keyEvent('keydown', { code: 'KeyE', isComposing: true, key: 'é' }))
      vi.runAllTimers()
      proxy.value = 'é'
      proxy.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'é' }))
    })

    expect(callRuntimeRpc).not.toHaveBeenCalledWith(
      { kind: 'local' },
      'emulator.type',
      expect.anything()
    )
    expect(decodedSentKeyboardFrames()).toEqual([
      { type: 'down', usage: 0xe2 },
      { type: 'down', usage: 0x08 },
      { type: 'up', usage: 0x08 },
      { type: 'up', usage: 0xe2 },
      { type: 'down', usage: 0x08 },
      { type: 'up', usage: 0x08 }
    ])
  })

  it('keeps a dead key typed during a commit when the simulator does not follow the Mac layout', async () => {
    vi.useFakeTimers()
    renderFrame()
    act(() => {
      FakeWebSocket.instances[0]?.open()
    })
    const screen = getScreen()
    const proxy = screen.querySelector<HTMLTextAreaElement>('[data-emulator-keyboard-proxy]')!
    await act(async () => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
    })
    let finishType: () => void = () => {}
    callRuntimeRpc.mockReturnValue(new Promise<void>((resolve) => (finishType = resolve)))

    const deadKey = keyEvent('keydown', { altKey: true, code: 'KeyE', key: 'Dead' })
    act(() => {
      proxy.value = '你好'
      proxy.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }))
      // Option+E then E while 你好 is still being typed: the Mac composes "é".
      proxy.dispatchEvent(deadKey)
      proxy.value = 'é'
      proxy.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'é' }))
    })
    callRuntimeRpc.mockResolvedValue(undefined)
    await act(async () => {
      finishType()
      await vi.runAllTimersAsync()
    })

    expect(deadKey.defaultPrevented).toBe(false)
    expect(callRuntimeRpc).toHaveBeenLastCalledWith({ kind: 'local' }, 'emulator.type', {
      text: 'é',
      worktree: 'wt-1'
    })
  })

  it('drops input still held when the pane closes', async () => {
    vi.useFakeTimers()
    renderFrame()
    act(() => {
      FakeWebSocket.instances[0]?.open()
    })
    const screen = getScreen()
    const proxy = screen.querySelector<HTMLTextAreaElement>('[data-emulator-keyboard-proxy]')!
    await act(async () => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
    })
    let finishType: () => void = () => {}
    callRuntimeRpc.mockReturnValue(new Promise<void>((resolve) => (finishType = resolve)))
    act(() => {
      proxy.value = '你好'
      proxy.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }))
      proxy.value = '。'
      proxy.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false }))
    })

    act(() => root.render(<div />))
    callRuntimeRpc.mockClear().mockResolvedValue(undefined)
    await act(async () => {
      finishType()
      await vi.runAllTimersAsync()
    })

    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('leaves a dead key to the Mac while a layout sync is still in flight', async () => {
    vi.useFakeTimers()
    let layoutChanged: (event: { phase: string }) => void = () => {}
    vi.stubGlobal('api', {
      app: {
        onKeyboardLayoutChanged: (listener: typeof layoutChanged) => {
          layoutChanged = listener
          return () => undefined
        }
      }
    })
    callRuntimeRpc.mockResolvedValue({ physicalKeys: true })
    renderFrame()
    act(() => {
      FakeWebSocket.instances[0]?.open()
    })
    const screen = getScreen()
    const proxy = screen.querySelector<HTMLTextAreaElement>('[data-emulator-keyboard-proxy]')!
    await act(async () => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
    })

    // The Mac switches input source; the new layout may have no simulator twin.
    callRuntimeRpc.mockReturnValue(new Promise(() => {}))
    act(() => layoutChanged({ phase: 'invalidated' }))
    const deadKey = keyEvent('keydown', { altKey: true, code: 'KeyE', key: 'Dead' })
    act(() => {
      proxy.dispatchEvent(deadKey)
    })

    expect(deadKey.defaultPrevented).toBe(false)
  })

  it('keeps an accent the Mac composes after a layout change that followed a simulator dead key', async () => {
    vi.useFakeTimers()
    let layoutChanged: (event: { phase: string }) => void = () => {}
    vi.stubGlobal('api', {
      app: {
        onKeyboardLayoutChanged: (listener: typeof layoutChanged) => {
          layoutChanged = listener
          return () => undefined
        }
      }
    })
    callRuntimeRpc.mockResolvedValue({ physicalKeys: true })
    renderFrame()
    act(() => {
      FakeWebSocket.instances[0]?.open()
    })
    const screen = getScreen()
    const proxy = screen.querySelector<HTMLTextAreaElement>('[data-emulator-keyboard-proxy]')!
    await act(async () => {
      screen.dispatchEvent(keyEvent('keydown', { key: 'Enter' }))
    })
    // The simulator takes a dead key physically, and the Mac never composes it.
    act(() => {
      proxy.dispatchEvent(keyEvent('keydown', { altKey: true, code: 'KeyE', key: 'Dead' }))
      vi.runAllTimers()
    })

    // The Mac switches to a layout the simulator has no twin for, then composes "é" itself.
    let finishSync: (result: { physicalKeys: boolean }) => void = () => {}
    callRuntimeRpc.mockReturnValue(new Promise((resolve) => (finishSync = resolve)))
    act(() => layoutChanged({ phase: 'invalidated' }))
    act(() => {
      proxy.dispatchEvent(keyEvent('keydown', { altKey: true, code: 'KeyE', key: 'Dead' }))
      proxy.value = 'é'
      proxy.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'é' }))
    })
    callRuntimeRpc.mockResolvedValue(undefined)
    await act(async () => {
      finishSync({ physicalKeys: false })
      await vi.runAllTimersAsync()
    })

    expect(callRuntimeRpc).toHaveBeenLastCalledWith({ kind: 'local' }, 'emulator.type', {
      text: 'é',
      worktree: 'wt-1'
    })
  })
})
