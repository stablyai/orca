import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTerminal, loadScheduler } from './pane-terminal-output-scheduler-test-harness'

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

const CHUNK_CHARS = 16 * 1024
// More than one drain's worth (2 writes × 16 KB), so the drain must reschedule itself.
const BACKLOG = Array.from({ length: 4 }, (_, index) => String(index).repeat(CHUNK_CHARS))
const BACKLOG_CHARS = BACKLOG.length * CHUNK_CHARS

function stubDocument(visibilityState: 'hidden' | 'visible'): EventTarget {
  const doc = Object.assign(new EventTarget(), { visibilityState })
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', new EventTarget())
  return doc
}

async function writeBacklog(): Promise<() => number> {
  const { writeTerminalOutput } = await loadScheduler()
  const terminal = createTerminal()
  for (const chunk of BACKLOG) {
    writeTerminalOutput(terminal, chunk, { foreground: false })
  }
  return () => terminal.write.mock.calls.reduce((total, [data]) => total + data.length, 0)
}

describe('background terminal output in a hidden page', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('drains the whole backlog without the bounded timer cadence', async () => {
    stubDocument('hidden')
    const writtenChars = await writeBacklog()

    vi.advanceTimersByTime(1)

    expect(writtenChars()).toBe(BACKLOG_CHARS)
  })

  it('keeps the bounded cadence while the page is visible', async () => {
    stubDocument('visible')
    const writtenChars = await writeBacklog()

    vi.advanceTimersByTime(49)
    expect(writtenChars()).toBe(0)
    vi.advanceTimersByTime(1)
    expect(writtenChars()).toBe(2 * CHUNK_CHARS)
    vi.advanceTimersByTime(16)
    expect(writtenChars()).toBe(BACKLOG_CHARS)
  })

  it('keeps the bounded cadence when input proves a hidden visibilityState stale', async () => {
    const doc = stubDocument('hidden')
    vi.resetModules()
    const { registerStaleDocumentVisibilityRecovery, resetStaleDocumentVisibilityForTesting } =
      await import('@/components/terminal-pane/stale-document-visibility')
    const { writeTerminalOutput } = await import('./pane-terminal-output-scheduler')
    registerStaleDocumentVisibilityRecovery(() => {})
    doc.dispatchEvent(new Event('keydown'))
    const terminal = createTerminal()
    for (const chunk of BACKLOG) {
      writeTerminalOutput(terminal, chunk, { foreground: false })
    }
    const writtenChars = (): number =>
      terminal.write.mock.calls.reduce((total, [data]) => total + data.length, 0)

    vi.advanceTimersByTime(49)
    expect(writtenChars()).toBe(0)
    vi.advanceTimersByTime(1)
    expect(writtenChars()).toBe(2 * CHUNK_CHARS)
    resetStaleDocumentVisibilityForTesting()
  })
})
