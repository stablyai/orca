import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTerminal, loadScheduler } from './pane-terminal-output-scheduler-test-harness'

vi.mock('@/lib/e2e-config', () => ({
  e2eConfig: { exposeStore: true }
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

// Why: discarded bytes xterm never parsed still owe their terminal query replies, so every
// discard hands them to the caller.
describe('pane terminal output scheduler discards', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('hands the unparsed queued bytes of a discard to the caller', async () => {
    const { writeTerminalOutput, discardTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    terminal.write.mockImplementation(() => {})
    writeTerminalOutput(terminal, 'one\x1b[6n', { foreground: true, latencySensitive: false })
    writeTerminalOutput(terminal, 'two\x1b[c', { foreground: true, latencySensitive: false })
    const onDiscardedData = vi.fn()

    discardTerminalOutput(terminal, onDiscardedData)

    expect(onDiscardedData).toHaveBeenCalledWith('one\x1b[6ntwo\x1b[c')
  })

  it('hands the bytes a backlog cap replaced to the drop callback', async () => {
    const { writeTerminalOutput, configureTerminalOutputBacklogCap } = await loadScheduler()
    configureTerminalOutputBacklogCap(1_000)
    const terminal = createTerminal()
    terminal.write.mockImplementation(() => {})
    const onBackgroundBacklogDropped = vi.fn()

    for (const marker of ['A', 'B', 'C']) {
      writeTerminalOutput(terminal, `${marker.repeat(1024 * 1024)}\x1b[6n`, {
        foreground: true,
        latencySensitive: false,
        onBackgroundBacklogDropped
      })
    }

    expect(onBackgroundBacklogDropped).toHaveBeenCalledTimes(1)
    const dropped = String(onBackgroundBacklogDropped.mock.calls[0]?.[0])
    expect(dropped).toContain('\x1b[6n')
  })
})
