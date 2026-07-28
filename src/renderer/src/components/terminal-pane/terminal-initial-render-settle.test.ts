import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduleTerminalInitialRenderSettled } from './terminal-initial-render-settle'

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  waitForTerminalOutputParsed: vi.fn(() => Promise.resolve())
}))

describe('scheduleTerminalInitialRenderSettled', () => {
  const frames: FrameRequestCallback[] = []

  beforeEach(() => {
    frames.length = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('waits for replay and content before two frames paint', async () => {
    let replaySettled = false
    let contentReady = false
    const onSettled = vi.fn()
    scheduleTerminalInitialRenderSettled({
      manager: { getPanes: () => [] },
      isCurrent: () => true,
      isReplaySettled: () => replaySettled,
      isContentReady: () => contentReady,
      onSettled
    })
    await Promise.resolve()

    frames.shift()?.(0)
    replaySettled = true
    frames.shift()?.(16)
    contentReady = true
    frames.shift()?.(32)
    expect(onSettled).not.toHaveBeenCalled()

    frames.shift()?.(48)
    expect(onSettled).toHaveBeenCalledOnce()
  })

  it('ignores queued work after cancellation', async () => {
    const onSettled = vi.fn()
    const cancel = scheduleTerminalInitialRenderSettled({
      manager: { getPanes: () => [] },
      isCurrent: () => true,
      isReplaySettled: () => true,
      isContentReady: () => true,
      onSettled
    })
    await Promise.resolve()
    cancel()

    frames.shift()?.(0)
    expect(onSettled).not.toHaveBeenCalled()
  })
})
