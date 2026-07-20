import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPaneTerminalOutputFrameGate,
  TERMINAL_OUTPUT_FRAME_FALLBACK_MS
} from './pane-terminal-output-frame-gate'

type ManualFrames = {
  pendingCount: () => number
  runNext: (timestamp?: number) => void
}

function installManualAnimationFrames(): ManualFrames {
  let nextId = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextId++
      callbacks.set(id, callback)
      return id
    })
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => {
      callbacks.delete(id)
    })
  )
  return {
    pendingCount: () => callbacks.size,
    runNext: (timestamp = 16) => {
      const next = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined
      if (!next) {
        throw new Error('No animation frame is pending')
      }
      callbacks.delete(next[0])
      next[1](timestamp)
    }
  }
}

describe('pane terminal output frame gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('fires once on the animation frame and disarms the fallback', () => {
    const frames = installManualAnimationFrames()
    const onFrame = vi.fn()
    const gate = createPaneTerminalOutputFrameGate(onFrame)

    gate.schedule()
    expect(gate.isPending()).toBe(true)
    frames.runNext()

    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(gate.isPending()).toBe(false)
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FRAME_FALLBACK_MS)
    expect(onFrame).toHaveBeenCalledTimes(1)
  })

  it('fires the one-shot fallback when no frame runs and ignores the stale frame', () => {
    installManualAnimationFrames()
    const onFrame = vi.fn()
    const gate = createPaneTerminalOutputFrameGate(onFrame)

    gate.schedule()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FRAME_FALLBACK_MS - 1)
    expect(onFrame).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(gate.isPending()).toBe(false)
  })

  it('ignores a stale frame callback that fires after the fallback released', () => {
    // Why: without cancelAnimationFrame (or when Chromium delivers a frame the
    // gate already cancelled), the stale callback must not double-drain.
    const captured: { frameCallback: FrameRequestCallback | null } = { frameCallback: null }
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        captured.frameCallback = callback
        return 7
      })
    )
    vi.stubGlobal('cancelAnimationFrame', undefined)
    const onFrame = vi.fn()
    const gate = createPaneTerminalOutputFrameGate(onFrame)

    gate.schedule()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FRAME_FALLBACK_MS)
    expect(onFrame).toHaveBeenCalledTimes(1)

    captured.frameCallback?.(16)
    expect(onFrame).toHaveBeenCalledTimes(1)
  })

  it('ignores a previous generation frame after cancel and reschedule', () => {
    const callbacks: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callbacks.push(callback)
        return callbacks.length
      })
    )
    vi.stubGlobal('cancelAnimationFrame', undefined)
    const onFrame = vi.fn()
    const gate = createPaneTerminalOutputFrameGate(onFrame)

    gate.schedule()
    gate.cancel()
    gate.schedule()
    callbacks[0]?.(16)
    expect(onFrame).not.toHaveBeenCalled()

    callbacks[1]?.(16)
    expect(onFrame).toHaveBeenCalledTimes(1)
  })

  it('cancel disarms both the frame and the fallback', () => {
    const frames = installManualAnimationFrames()
    const onFrame = vi.fn()
    const gate = createPaneTerminalOutputFrameGate(onFrame)

    gate.schedule()
    gate.cancel()

    expect(gate.isPending()).toBe(false)
    expect(frames.pendingCount()).toBe(0)
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FRAME_FALLBACK_MS)
    expect(onFrame).not.toHaveBeenCalled()
  })

  it('schedule while pending keeps the single armed frame', () => {
    const frames = installManualAnimationFrames()
    const requestFrame = vi.mocked(globalThis.requestAnimationFrame)
    const onFrame = vi.fn()
    const gate = createPaneTerminalOutputFrameGate(onFrame)

    gate.schedule()
    gate.schedule()
    gate.schedule()

    expect(requestFrame).toHaveBeenCalledTimes(1)
    frames.runNext()
    expect(onFrame).toHaveBeenCalledTimes(1)
  })

  it('does not resurrect a synchronously invoked frame with its returned id', () => {
    // Why: test and embedded runtimes can invoke the rAF callback inside the
    // request call; the returned id must not re-arm an already-released gate.
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(16)
        return 99
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const onFrame = vi.fn()
    const gate = createPaneTerminalOutputFrameGate(onFrame)

    gate.schedule()

    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(gate.isPending()).toBe(false)
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FRAME_FALLBACK_MS)
    expect(onFrame).toHaveBeenCalledTimes(1)
  })

  it('runs on the fallback alone when requestAnimationFrame is unavailable', () => {
    vi.stubGlobal('requestAnimationFrame', undefined)
    vi.stubGlobal('cancelAnimationFrame', undefined)
    const onFrame = vi.fn()
    const gate = createPaneTerminalOutputFrameGate(onFrame)

    gate.schedule()
    expect(gate.isPending()).toBe(true)
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FRAME_FALLBACK_MS)

    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(gate.isPending()).toBe(false)
  })

  it('can be rescheduled and fired again after a release', () => {
    const frames = installManualAnimationFrames()
    const onFrame = vi.fn()
    const gate = createPaneTerminalOutputFrameGate(onFrame)

    gate.schedule()
    frames.runNext()
    gate.schedule()
    expect(gate.isPending()).toBe(true)
    frames.runNext()

    expect(onFrame).toHaveBeenCalledTimes(2)
    expect(gate.isPending()).toBe(false)
  })
})
