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
