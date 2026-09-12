import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createForegroundTerminal,
  createTerminal,
  loadScheduler
} from './pane-terminal-output-scheduler-test-harness'

vi.mock('@/lib/e2e-config', () => ({
  e2eConfig: { exposeStore: true }
}))

const mocks = vi.hoisted(() => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: mocks.recordRendererCrashBreadcrumb
}))

describe('pane terminal output scheduler', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis)
    mocks.recordRendererCrashBreadcrumb.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { __terminalOutputSchedulerDebug?: unknown })
      .__terminalOutputSchedulerDebug
    vi.unstubAllGlobals()
  })

  it('writes foreground output immediately', async () => {
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    writeTerminalOutput(terminal, 'foreground', { foreground: true })

    expect(terminal.write).toHaveBeenCalledWith('foreground', expect.any(Function))
  })

  it('runs parsed callbacks after immediate foreground output parses', async () => {
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    let parseCallback: (() => void) | undefined
    terminal.write.mockImplementation((_data: string, callback?: () => void) => {
      parseCallback = callback
    })
    const onParsed = vi.fn()

    writeTerminalOutput(terminal, 'foreground', {
      foreground: true,
      onParsed
    })

    expect(onParsed).not.toHaveBeenCalled()
    parseCallback?.()
    expect(onParsed).toHaveBeenCalledTimes(1)
  })

  it('runs parsed callbacks after queued foreground output parses', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    let parseCallback: (() => void) | undefined
    terminal.write.mockImplementation((_data: string, callback?: () => void) => {
      parseCallback = callback
    })
    const onParsed = vi.fn()

    writeTerminalOutput(terminal, 'queued', {
      foreground: true,
      latencySensitive: false,
      onParsed
    })

    vi.advanceTimersByTime(0)

    expect(terminal.write).toHaveBeenCalledWith('queued', expect.any(Function))
    expect(onParsed).not.toHaveBeenCalled()
    parseCallback?.()
    expect(onParsed).toHaveBeenCalledTimes(1)
  })

  it('synchronously refreshes visible rows after foreground output parses', async () => {
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()
    terminal.write.mockImplementation((_data: string, callback?: () => void) => {
      terminal.buffer.active.cursorY = 3
      callback?.()
    })

    writeTerminalOutput(terminal, '中文 PowerShell repaint\r\n', {
      foreground: true,
      forceForegroundRefresh: true
    })

    expect(terminal._core.refresh).toHaveBeenCalledWith(0, 23, true)
    expect(terminal.refresh).not.toHaveBeenCalled()
  })

  it('coalesces a WebGL foreground refresh through xterm public refresh', async () => {
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()

    writeTerminalOutput(terminal, 'active TUI repaint\r\n', {
      foreground: true,
      forceForegroundRefresh: true,
      shouldRefreshForegroundSynchronously: () => false
    })

    expect(terminal.refresh).toHaveBeenCalledWith(0, 23)
    expect(terminal._core.refresh).not.toHaveBeenCalled()
  })

  it('resolves the live renderer after xterm finishes parsing', async () => {
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()
    let parseCallback: (() => void) | undefined
    let webglLive = false
    terminal.write.mockImplementation((_data: string, callback?: () => void) => {
      parseCallback = callback
    })

    writeTerminalOutput(terminal, 'queued renderer transition\r\n', {
      foreground: true,
      forceForegroundRefresh: true,
      shouldRefreshForegroundSynchronously: () => !webglLive
    })
    webglLive = true
    parseCallback?.()

    expect(terminal.refresh).toHaveBeenCalledWith(0, 23)
    expect(terminal._core.refresh).not.toHaveBeenCalled()
  })

  it('keeps the WebGL follow-up repair on the debounced path', async () => {
    const scheduledFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      scheduledFrames.push(callback)
      return scheduledFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()

    writeTerminalOutput(terminal, 'WebGL cursor restore', {
      foreground: true,
      forceForegroundRefresh: true,
      followupForegroundRefresh: true,
      shouldRefreshForegroundSynchronously: () => false
    })

    expect(terminal.refresh).toHaveBeenCalledTimes(1)
    expect(scheduledFrames).toHaveLength(1)
    scheduledFrames[0]?.(16)

    expect(terminal.refresh).toHaveBeenCalledTimes(2)
    expect(terminal._core.refresh).not.toHaveBeenCalled()
  })

  it('resolves WebGL loss again before the follow-up repair', async () => {
    const scheduledFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      scheduledFrames.push(callback)
      return scheduledFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()
    let webglLive = true

    writeTerminalOutput(terminal, 'renderer transition', {
      foreground: true,
      forceForegroundRefresh: true,
      followupForegroundRefresh: true,
      shouldRefreshForegroundSynchronously: () => !webglLive
    })

    expect(terminal.refresh).toHaveBeenCalledTimes(1)
    webglLive = false
    scheduledFrames[0]?.(16)

    expect(terminal._core.refresh).toHaveBeenCalledWith(0, 23, true)
  })

  it('repaints the viewport again on the next frame when foreground output scrolls', async () => {
    const scheduledFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      scheduledFrames.push(callback)
      return scheduledFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()
    terminal.buffer.active.baseY = 10
    terminal.buffer.active.viewportY = 10
    terminal.write.mockImplementation((_data: string, callback?: () => void) => {
      terminal.buffer.active.baseY = 11
      terminal.buffer.active.viewportY = 11
      callback?.()
    })

    writeTerminalOutput(terminal, '顶部滚动中文复现\r\n', {
      foreground: true,
      forceForegroundRefresh: true
    })

    expect(terminal._core.refresh).toHaveBeenCalledTimes(1)
    expect(scheduledFrames).toHaveLength(1)

    scheduledFrames[0]?.(16)

    expect(terminal._core.refresh).toHaveBeenCalledTimes(2)
    expect(terminal._core.refresh).toHaveBeenLastCalledWith(0, 23, true)
  })

  it('can force a follow-up repaint after cursor-only foreground restores', async () => {
    const scheduledFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      scheduledFrames.push(callback)
      return scheduledFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()

    writeTerminalOutput(terminal, '\x1b[?25l\x1b[13;4H\x1b[?25h', {
      foreground: true,
      forceForegroundRefresh: true,
      followupForegroundRefresh: true
    })

    expect(terminal._core.refresh).toHaveBeenCalledTimes(1)
    expect(scheduledFrames).toHaveLength(1)

    scheduledFrames[0]?.(16)

    expect(terminal._core.refresh).toHaveBeenCalledTimes(2)
    expect(terminal._core.refresh).toHaveBeenLastCalledWith(0, 23, true)
  })

  it('schedules a follow-up repaint for a Claude-style in-place CR redraw without scroll', async () => {
    // Why: issue #5656/#5653 — Claude Code's plain-ASCII prompt redraw (CR + CHA +
    // reprint + erase-line, no DEC 2026, no scroll, no cursor hide/show restore)
    // paints one frame late on Windows ConPTY. A single sync refresh races that
    // late paint, so the connection layer requests followupForegroundRefresh.
    // Prove the scheduler turns that into a second next-frame repaint.
    const scheduledFrames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      scheduledFrames.push(callback)
      return scheduledFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()

    writeTerminalOutput(terminal, '\r\x1b[3Gzzzx\x1b[K', {
      foreground: true,
      latencySensitive: true,
      forceForegroundRefresh: true,
      followupForegroundRefresh: true
    })

    expect(terminal._core.refresh).toHaveBeenCalledTimes(1)
    expect(scheduledFrames).toHaveLength(1)

    scheduledFrames[0]?.(16)

    expect(terminal._core.refresh).toHaveBeenCalledTimes(2)
    expect(terminal._core.refresh).toHaveBeenLastCalledWith(0, 23, true)
  })

  it('skips forced viewport refresh for ordinary foreground output', async () => {
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()

    writeTerminalOutput(terminal, 'plain foreground output\r\n', { foreground: true })

    expect(terminal._core.refresh).not.toHaveBeenCalled()
    expect(terminal.refresh).not.toHaveBeenCalled()
  })

  it('ignores unforced chunks when resolving a coalesced forced refresh', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()

    writeTerminalOutput(terminal, 'forced', {
      foreground: true,
      latencySensitive: false,
      forceForegroundRefresh: true,
      shouldRefreshForegroundSynchronously: () => false
    })
    writeTerminalOutput(terminal, ' ordinary', {
      foreground: true,
      latencySensitive: false
    })
    vi.advanceTimersByTime(0)

    expect(terminal.refresh).toHaveBeenCalledWith(0, 23)
    expect(terminal._core.refresh).not.toHaveBeenCalled()
  })
})
