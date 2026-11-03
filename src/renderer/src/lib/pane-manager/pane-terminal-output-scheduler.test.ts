import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTerminal, loadScheduler } from './pane-terminal-output-scheduler-test-harness'

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

  it('supports bounded explicit flushes for visibility resume', async () => {
    vi.useFakeTimers()
    const { flushTerminalOutput, writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const chunk = 'x'.repeat(16 * 1024)

    for (let i = 0; i < 16; i++) {
      writeTerminalOutput(terminal, chunk, { foreground: false })
    }

    flushTerminalOutput(terminal, { maxChars: 64 * 1024 })

    expect(terminal.write).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(50)
    expect(terminal.write.mock.calls.length).toBeGreaterThan(4)
  })

  it('rotates terminals with remaining backlog behind untouched queued terminals', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminals = [createTerminal(), createTerminal(), createTerminal()]
    const largeChunk = 'x'.repeat(20 * 1024)

    writeTerminalOutput(terminals[0], largeChunk, { foreground: false })
    writeTerminalOutput(terminals[1], 'pane-1', { foreground: false })
    writeTerminalOutput(terminals[2], 'pane-2', { foreground: false })

    vi.advanceTimersByTime(50)
    expect(terminals[0].write).toHaveBeenCalledTimes(1)
    expect(terminals[1].write).toHaveBeenCalledWith('pane-1', expect.any(Function))
    expect(terminals[2].write).not.toHaveBeenCalled()

    // Reinsert residual entries at the Map’s tail so one burst cannot starve queued siblings.
    vi.advanceTimersByTime(16)
    expect(terminals[2].write).toHaveBeenCalledWith('pane-2', expect.any(Function))
    expect(terminals[0].write).toHaveBeenCalledTimes(2)
  })

  it('yields high-priority backlog drains when writes spend the frame budget', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const chunk = 'x'.repeat(16 * 1024)
    let now = 0
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now)
    terminal.write.mockImplementation((_data: string, callback?: () => void) => {
      now += 9
      callback?.()
    })

    try {
      for (let i = 0; i < 64; i++) {
        writeTerminalOutput(terminal, chunk, { foreground: false })
      }

      vi.advanceTimersByTime(0)
      expect(terminal.write).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(4)
      expect(terminal.write).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('preserves byte order when foreground output is queued behind a large hidden backlog', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const chunk = 'x'.repeat(16 * 1024)

    for (let i = 0; i < 64; i++) {
      writeTerminalOutput(terminal, `${String(i).padStart(2, '0')}:${chunk}`, {
        foreground: false
      })
    }

    writeTerminalOutput(terminal, 'visible', { foreground: true })
    vi.runAllTimers()

    const expected = `${Array.from(
      { length: 64 },
      (_, i) => `${String(i).padStart(2, '0')}:${chunk}`
    ).join('')}visible`
    expect(terminal.write.mock.calls.map(([data]) => data).join('')).toBe(expected)
    expect(terminal.write).toHaveBeenLastCalledWith('visible', expect.any(Function))
  })
})
