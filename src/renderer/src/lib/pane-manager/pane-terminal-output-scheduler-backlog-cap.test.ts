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

  it('caps hidden backlog memory and writes a warning instead of retaining all output', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const chunk = 'x'.repeat(512 * 1024)

    for (let i = 0; i < 5; i++) {
      writeTerminalOutput(terminal, chunk, { foreground: false })
    }
    writeTerminalOutput(terminal, 'after-cap\r\n', { foreground: false })

    vi.advanceTimersByTime(0)

    const output = terminal.write.mock.calls.map(([data]) => data).join('')
    expect(output).toContain('Orca skipped hidden terminal output')
    expect(output).toContain('after-cap')
    expect(output).not.toContain('x'.repeat(1024))
  })

  it('caps a visible pane backlog the drain cannot keep up with and writes a warning', async () => {
    // Visible floods were uncapped and grew renderer RSS near 1.5GB before freeze.
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const chunk = 'x'.repeat(512 * 1024)

    for (let i = 0; i < 5; i++) {
      writeTerminalOutput(terminal, chunk, { foreground: true, latencySensitive: false })
    }
    writeTerminalOutput(terminal, 'after-cap\r\n', { foreground: true, latencySensitive: false })

    vi.advanceTimersByTime(0)

    const output = terminal.write.mock.calls.map(([data]) => data).join('')
    expect(output).toContain('Orca skipped a burst of terminal output')
    expect(output).toContain('after-cap')
    expect(output).not.toContain('x'.repeat(1024))
  })

  it('scales the backlog cap with the scrollback setting', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput, configureTerminalOutputBacklogCap } = await loadScheduler()
    const terminal = createTerminal()
    const chunk = 'x'.repeat(512 * 1024)

    // 50k-row scrollback raises the cap to 6MB; preserve a 2.5MB flood above the 2MB floor.
    configureTerminalOutputBacklogCap(50_000)
    for (let i = 0; i < 5; i++) {
      writeTerminalOutput(terminal, chunk, { foreground: true, latencySensitive: false })
    }
    vi.advanceTimersByTime(0)

    let output = terminal.write.mock.calls.map(([data]) => data).join('')
    expect(output).not.toContain('Orca skipped')
    expect(output).toContain('x'.repeat(1024))

    terminal.write.mockClear()
    for (let i = 0; i < 13; i++) {
      writeTerminalOutput(terminal, chunk, { foreground: true, latencySensitive: false })
    }
    vi.advanceTimersByTime(0)
    output = terminal.write.mock.calls.map(([data]) => data).join('')
    expect(output).toContain('Orca skipped a burst of terminal output')
  })

  it('caps a held/coalesced foreground backlog as well', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createForegroundTerminal()
    const chunk = 'y'.repeat(512 * 1024)

    // Exercise the synchronized-output hold used by a flooding TUI.
    for (let i = 0; i < 5; i++) {
      writeTerminalOutput(terminal, chunk, { foreground: true, holdForeground: true })
    }

    vi.advanceTimersByTime(1_000)

    const output = terminal.write.mock.calls.map(([data]) => data).join('')
    expect(output).toContain('Orca skipped a burst of terminal output')
    expect(output).not.toContain('y'.repeat(1024))
  })

  it('caps hidden backlog chunk count even when each chunk is tiny', async () => {
    vi.useFakeTimers()
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()

    for (let i = 0; i < 4097; i++) {
      writeTerminalOutput(terminal, 'x', { foreground: false })
    }

    vi.advanceTimersByTime(0)

    const output = terminal.write.mock.calls.map(([data]) => data).join('')
    expect(output).toContain('Orca skipped hidden terminal output')
    expect(output).not.toContain('x'.repeat(512))
  })

  it('requests registered recovery instead of flushing a dropped hidden backlog', async () => {
    vi.useFakeTimers()
    const { flushTerminalOutput, registerTerminalBacklogRecovery, writeTerminalOutput } =
      await loadScheduler()
    const terminal = createTerminal()
    const requestRecovery = vi.fn(() => true)
    const unregister = registerTerminalBacklogRecovery(terminal, requestRecovery)
    const chunk = 'x'.repeat(512 * 1024)

    try {
      for (let i = 0; i < 5; i++) {
        writeTerminalOutput(terminal, chunk, { foreground: false })
      }

      flushTerminalOutput(terminal)

      expect(requestRecovery).toHaveBeenCalledTimes(1)
      expect(terminal.write).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })
})
