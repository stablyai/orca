// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { createElement } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPreviewDataPayload } from '../../../../shared/terminal-preview'
import {
  createPassiveAgentTerminalLiveQueue,
  retainAgentTerminalPreviewConnection,
  scheduleAgentTerminalPreviewFrameTask,
  subscribeAgentTerminalPreviewStream
} from './agent-terminal-preview-stream'

type PreviewTerminal = {
  options: Record<string, unknown>
  write: ReturnType<typeof vi.fn>
  writeCallbacks: (() => void)[]
  focus: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  onData: ReturnType<typeof vi.fn>
  textarea: HTMLTextAreaElement
}

const terminalHarness = vi.hoisted(() => ({ instances: [] as PreviewTerminal[] }))
const ownershipHarness = vi.hoisted(() => ({
  claimGrid: vi.fn(),
  createClipboardPaster: vi.fn(),
  installAppMenuClipboard: vi.fn(),
  installCompatibility: vi.fn(),
  installImeBridge: vi.fn(),
  installKeyHandler: vi.fn(),
  subscribeUserInput: vi.fn()
}))
const storeState = vi.hoisted(() => ({ settings: null, keybindings: {} }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    buffer = { active: { cursorY: 0 } }
    options: Record<string, unknown>
    textarea = document.createElement('textarea')
    element = document.createElement('div')
    unicode = { activeVersion: '6', versions: ['6', '11'], register: vi.fn() }
    writeCallbacks: (() => void)[] = []
    write = vi.fn((_data: string, callback?: () => void) => {
      if (callback) {
        this.writeCallbacks.push(callback)
      }
    })
    open = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    resize = vi.fn()
    reset = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    loadAddon = vi.fn()

    constructor(options: Record<string, unknown>) {
      this.options = options
      terminalHarness.instances.push(this)
    }
  }
}))
vi.mock(import('@/lib/pane-manager/pane-terminal-options'), async (importOriginal) => ({
  ...(await importOriginal()),
  buildDefaultTerminalOptions: () => ({})
}))
vi.mock('@/components/terminal-pane/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => false
}))
vi.mock('@/lib/keyboard-layout/use-effective-mac-option-as-alt', () => ({
  useEffectiveMacOptionAsAlt: () => 'false'
}))
vi.mock('@/components/terminal-pane/terminal-user-input-signal', () => ({
  subscribeToTerminalUserInput: ownershipHarness.subscribeUserInput
}))
vi.mock('./preview-grid-claim', () => ({ createPreviewGridClaim: ownershipHarness.claimGrid }))
vi.mock('./preview-terminal-paste', () => ({
  createPreviewClipboardPaster: ownershipHarness.createClipboardPaster
}))
vi.mock('./preview-terminal-app-menu-clipboard', () => ({
  installPreviewTerminalAppMenuClipboard: ownershipHarness.installAppMenuClipboard
}))
vi.mock('./preview-terminal-compatibility', () => ({
  installPreviewTerminalCompatibility: ownershipHarness.installCompatibility
}))
vi.mock('./preview-terminal-ime-bridge', () => ({
  installPreviewImeBridge: ownershipHarness.installImeBridge
}))
vi.mock('./preview-terminal-key-handler', () => ({
  installPreviewTerminalKeyHandler: ownershipHarness.installKeyHandler
}))
vi.mock('@/store', () => {
  const useAppStore = (selector: (state: typeof storeState) => unknown): unknown =>
    selector(storeState)
  useAppStore.getState = (): typeof storeState => storeState
  return { useAppStore }
})

import { AgentTerminalPreview } from './AgentTerminalPreview'

describe('agent terminal preview stream', () => {
  const disposeGlobalListener = vi.fn()
  const onData = vi.fn()
  const connect = vi.fn()
  const input = vi.fn(async () => true)
  const fit = vi.fn(async (_ptyId: string, cols: number, rows: number) => ({ cols, rows }))
  const ack = vi.fn(async () => undefined)
  const unsubscribe = vi.fn(async () => undefined)
  let emit: ((payload: TerminalPreviewDataPayload) => void) | null = null

  beforeEach(() => {
    terminalHarness.instances.length = 0
    emit = null
    connect.mockResolvedValue({
      snapshot: { data: '', cols: 80, rows: 24, seq: 1 },
      replay: []
    })
    onData.mockImplementation((listener: (payload: TerminalPreviewDataPayload) => void) => {
      emit = listener
      return disposeGlobalListener
    })
    Object.assign(window, {
      api: {
        terminalPreview: { ack, connect, fit, input, onData, unsubscribe }
      }
    })
    vi.clearAllMocks()
    ownershipHarness.claimGrid.mockReturnValue({ schedule: vi.fn(), dispose: vi.fn() })
    ownershipHarness.createClipboardPaster.mockReturnValue(vi.fn())
    ownershipHarness.installAppMenuClipboard.mockReturnValue(vi.fn())
    ownershipHarness.installCompatibility.mockReturnValue(vi.fn())
    ownershipHarness.installImeBridge.mockReturnValue(null)
    ownershipHarness.installKeyHandler.mockReturnValue(vi.fn())
    ownershipHarness.subscribeUserInput.mockReturnValue({ dispose: vi.fn() })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('routes payloads only to listeners for the exact PTY', () => {
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    const disposeFirst = subscribeAgentTerminalPreviewStream('pty-1', firstListener)
    const disposeSecond = subscribeAgentTerminalPreviewStream('pty-2', secondListener)

    expect(onData).toHaveBeenCalledOnce()
    emit?.({ type: 'data', ptyId: 'pty-2', data: 'two', bytes: 3 })

    expect(firstListener).not.toHaveBeenCalled()
    expect(secondListener).toHaveBeenCalledExactlyOnceWith({
      type: 'data',
      ptyId: 'pty-2',
      data: 'two',
      bytes: 3
    })

    disposeFirst()
    expect(disposeGlobalListener).not.toHaveBeenCalled()
    disposeSecond()
    expect(disposeGlobalListener).toHaveBeenCalledOnce()
  })

  it('fans one PTY payload out to every exact listener', async () => {
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    const disposeFirst = subscribeAgentTerminalPreviewStream('pty-1', firstListener)
    const disposeSecond = subscribeAgentTerminalPreviewStream('pty-1', secondListener)

    emit?.({ type: 'resync', ptyId: 'pty-1' })

    expect(firstListener).toHaveBeenCalledExactlyOnceWith({ type: 'resync', ptyId: 'pty-1' })
    expect(secondListener).toHaveBeenCalledExactlyOnceWith({ type: 'resync', ptyId: 'pty-1' })
    disposeFirst()
    disposeSecond()
  })

  it('acknowledges one PTY payload once after every exact listener settles', async () => {
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstListener = vi.fn(() => new Promise<void>((resolve) => (releaseFirst = resolve)))
    const secondListener = vi.fn(() => new Promise<void>((resolve) => (releaseSecond = resolve)))
    const disposeFirst = subscribeAgentTerminalPreviewStream('pty-1', firstListener)
    const disposeSecond = subscribeAgentTerminalPreviewStream('pty-1', secondListener)

    emit?.({ type: 'data', ptyId: 'pty-1', data: 'shared', bytes: 6 })
    releaseFirst()
    await Promise.resolve()
    expect(ack).not.toHaveBeenCalled()
    releaseSecond()
    await waitFor(() => expect(ack).toHaveBeenCalledExactlyOnceWith('pty-1', 6))

    disposeFirst()
    disposeSecond()
  })

  it('releases memberships idempotently and reinstalls the global listener after teardown', () => {
    const disposeFirst = subscribeAgentTerminalPreviewStream('pty-1', vi.fn())

    disposeFirst()
    disposeFirst()
    expect(disposeGlobalListener).toHaveBeenCalledOnce()

    const disposeSecond = subscribeAgentTerminalPreviewStream('pty-2', vi.fn())
    expect(onData).toHaveBeenCalledTimes(2)
    disposeSecond()
    expect(disposeGlobalListener).toHaveBeenCalledTimes(2)
  })

  it('mounts one passive terminal per animation frame and skips cancelled work', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const first = vi.fn()
    const cancelled = vi.fn()
    const third = vi.fn()

    scheduleAgentTerminalPreviewFrameTask(first)
    const cancelSecond = scheduleAgentTerminalPreviewFrameTask(cancelled)
    scheduleAgentTerminalPreviewFrameTask(third)
    cancelSecond()

    expect(frames).toHaveLength(1)
    frames.shift()!(0)
    expect(first).toHaveBeenCalledOnce()
    expect(cancelled).not.toHaveBeenCalled()
    expect(third).not.toHaveBeenCalled()
    expect(frames).toHaveLength(1)

    frames.shift()!(16)
    expect(cancelled).not.toHaveBeenCalled()
    expect(third).toHaveBeenCalledOnce()
    expect(frames).toHaveLength(0)
  })

  it('flushes one ready passive queue per animation frame', async () => {
    vi.useFakeTimers()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const firstWrite = vi.fn(async () => undefined)
    const secondWrite = vi.fn(async () => undefined)
    const first = createPassiveAgentTerminalLiveQueue({
      ptyId: 'pty-first',
      intervalMs: 20,
      isDisposed: () => false,
      write: firstWrite
    })
    const second = createPassiveAgentTerminalLiveQueue({
      ptyId: 'pty-second',
      intervalMs: 20,
      isDisposed: () => false,
      write: secondWrite
    })

    const firstDone = first.write({ type: 'data', ptyId: 'pty-first', data: 'one', bytes: 3 })
    const secondDone = second.write({ type: 'data', ptyId: 'pty-second', data: 'two', bytes: 3 })
    await vi.advanceTimersByTimeAsync(20)

    expect(frames).toHaveLength(1)
    frames.shift()!(16)
    await firstDone
    expect(firstWrite).toHaveBeenCalledOnce()
    expect(secondWrite).not.toHaveBeenCalled()
    expect(frames).toHaveLength(1)

    frames.shift()!(32)
    await secondDone
    expect(secondWrite).toHaveBeenCalledOnce()
  })

  it('renders live output passively without interactive terminal ownership', async () => {
    connect.mockResolvedValue({
      snapshot: { data: 'initial', cols: 80, rows: 24, seq: 1 },
      replay: []
    })
    const view = render(
      createElement(AgentTerminalPreview, { ptyId: 'pty-1', mode: 'passive', autoFocus: true })
    )
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!

    expect(terminal.options.disableStdin).toBe(true)
    expect(terminal.focus).not.toHaveBeenCalled()
    expect(terminal.textarea.getAttribute('tabindex')).toBe('-1')
    expect(view.container.querySelector('[data-terminal-preview-mode="passive"]')).not.toBeNull()
    expect(view.container.querySelector('.origin-bottom-left')).toHaveClass('pointer-events-none')
    expect(ownershipHarness.claimGrid).not.toHaveBeenCalled()
    expect(ownershipHarness.createClipboardPaster).not.toHaveBeenCalled()
    expect(ownershipHarness.installAppMenuClipboard).not.toHaveBeenCalled()
    expect(ownershipHarness.installCompatibility).not.toHaveBeenCalled()
    expect(ownershipHarness.installImeBridge).not.toHaveBeenCalled()
    expect(ownershipHarness.installKeyHandler).not.toHaveBeenCalled()
    expect(ownershipHarness.subscribeUserInput).not.toHaveBeenCalled()

    act(() => emit?.({ type: 'data', ptyId: 'pty-1', data: 'live', bytes: 4 }))
    expect(terminal.write).toHaveBeenCalledWith('live', expect.any(Function))
    act(() => terminal.writeCallbacks.splice(0).forEach((callback) => callback()))
    await waitFor(() => expect(ack).toHaveBeenCalledExactlyOnceWith('pty-1', 4))
    expect(input).not.toHaveBeenCalled()
    expect(fit).not.toHaveBeenCalled()

    view.unmount()
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('pty-1'))
    expect(terminal.dispose).toHaveBeenCalledOnce()
  })

  it('preserves one Canvas terminal while selection changes input ownership', async () => {
    const view = render(
      createElement(AgentTerminalPreview, {
        ptyId: 'pty-canvas',
        mode: 'canvas',
        inputEnabled: false,
        autoFocus: false,
        liveRefreshIntervalMs: 140
      })
    )
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    expect(terminal.options.disableStdin).toBe(true)

    view.rerender(
      createElement(AgentTerminalPreview, {
        ptyId: 'pty-canvas',
        mode: 'canvas',
        inputEnabled: true,
        autoFocus: true,
        liveRefreshIntervalMs: 64
      })
    )
    expect(terminalHarness.instances).toHaveLength(1)
    expect(connect).toHaveBeenCalledOnce()
    expect(terminal.dispose).not.toHaveBeenCalled()
    expect(terminal.options.disableStdin).toBe(false)
    expect(terminal.focus).toHaveBeenCalled()

    view.rerender(
      createElement(AgentTerminalPreview, {
        ptyId: 'pty-canvas',
        mode: 'canvas',
        inputEnabled: false,
        autoFocus: false,
        liveRefreshIntervalMs: 140
      })
    )
    expect(terminalHarness.instances).toHaveLength(1)
    expect(connect).toHaveBeenCalledOnce()
    expect(terminal.dispose).not.toHaveBeenCalled()
    expect(terminal.options.disableStdin).toBe(true)
  })

  it('keeps a shared PTY connection until its final preview releases it', async () => {
    const first = render(
      createElement(AgentTerminalPreview, { ptyId: 'pty-shared', mode: 'passive' })
    )
    const second = render(
      createElement(AgentTerminalPreview, { ptyId: 'pty-shared', mode: 'passive' })
    )
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(2))
    expect(connect).toHaveBeenCalledOnce()

    first.unmount()
    expect(unsubscribe).not.toHaveBeenCalled()
    second.unmount()
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('pty-shared'))
  })

  it('keeps a remounted PTY connection across the release microtask', async () => {
    const releaseFirst = retainAgentTerminalPreviewConnection('pty-remount')
    releaseFirst()
    const releaseReplacement = retainAgentTerminalPreviewConnection('pty-remount')

    await Promise.resolve()
    expect(unsubscribe).not.toHaveBeenCalled()

    releaseReplacement()
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('pty-remount'))
  })

  it('batches passive Canvas output while acknowledging each exact payload', async () => {
    render(
      createElement(AgentTerminalPreview, {
        ptyId: 'pty-batched',
        mode: 'passive',
        liveRefreshIntervalMs: 20
      })
    )
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    act(() => terminal.writeCallbacks.splice(0).forEach((callback) => callback()))
    terminal.write.mockClear()

    act(() => {
      emit?.({ type: 'data', ptyId: 'pty-batched', data: 'one', bytes: 3 })
      emit?.({ type: 'data', ptyId: 'pty-batched', data: 'two', bytes: 3 })
    })
    expect(terminal.write).not.toHaveBeenCalled()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)))
    await waitFor(() =>
      expect(terminal.write).toHaveBeenCalledExactlyOnceWith('onetwo', expect.any(Function))
    )
    act(() => terminal.writeCallbacks.splice(0).forEach((callback) => callback()))
    await waitFor(() => expect(ack).toHaveBeenCalledTimes(2))
    expect(ack).toHaveBeenCalledWith('pty-batched', 3)
  })

  it('fits passive output after snapshots, not live writes, and cancels teardown work', async () => {
    const frameCallbacks = new Map<number, FrameRequestCallback>()
    let nextFrameId = 0
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      const frameId = ++nextFrameId
      frameCallbacks.set(frameId, callback)
      return frameId
    })
    const cancelFrame = vi.fn((frameId: number) => frameCallbacks.delete(frameId))
    const disconnectResizeObserver = vi.fn()
    vi.stubGlobal('requestAnimationFrame', requestFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelFrame)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = disconnectResizeObserver
      }
    )
    connect
      .mockResolvedValueOnce({
        snapshot: { data: 'first', cols: 80, rows: 24, seq: 1 },
        replay: []
      })
      .mockResolvedValueOnce({
        snapshot: { data: 'second', cols: 100, rows: 30, seq: 2 },
        replay: []
      })

    const view = render(createElement(AgentTerminalPreview, { ptyId: 'pty-1', mode: 'passive' }))
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    act(() => terminal.writeCallbacks.splice(0).forEach((callback) => callback()))
    expect(requestFrame).toHaveBeenCalledOnce()

    const firstFrame = frameCallbacks.get(1)!
    frameCallbacks.delete(1)
    act(() => firstFrame(0))
    act(() => emit?.({ type: 'data', ptyId: 'pty-1', data: 'live', bytes: 4 }))
    act(() => terminal.writeCallbacks.splice(0).forEach((callback) => callback()))
    expect(requestFrame).toHaveBeenCalledOnce()

    act(() => emit?.({ type: 'resync', ptyId: 'pty-1' }))
    await waitFor(() => expect(terminal.resize).toHaveBeenCalledWith(100, 30))
    act(() => terminal.writeCallbacks.splice(0).forEach((callback) => callback()))
    expect(requestFrame).toHaveBeenCalledTimes(2)

    view.unmount()
    expect(cancelFrame).toHaveBeenCalledExactlyOnceWith(2)
    expect(disconnectResizeObserver).toHaveBeenCalledOnce()
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('pty-1'))
    expect(terminal.dispose).toHaveBeenCalledOnce()
  })
})
