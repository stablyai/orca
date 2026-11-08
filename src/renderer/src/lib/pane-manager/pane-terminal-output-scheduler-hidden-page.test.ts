import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTerminal, loadScheduler } from './pane-terminal-output-scheduler-test-harness'

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

describe('background terminal output in a hidden page', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('drains the whole backlog in order', async () => {
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'hidden' }))
    vi.stubGlobal('window', new EventTarget())
    const { writeTerminalOutput } = await loadScheduler()
    const terminal = createTerminal()
    const chunks = Array.from({ length: 8 }, (_, index) => String(index).repeat(16 * 1024))

    for (const chunk of chunks) {
      writeTerminalOutput(terminal, chunk, { foreground: false })
    }
    vi.runAllTimers()

    expect(terminal.write.mock.calls.map(([data]) => data).join('')).toBe(chunks.join(''))
  })
})
