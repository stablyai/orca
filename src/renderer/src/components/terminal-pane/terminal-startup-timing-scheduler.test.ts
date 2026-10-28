import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createTerminal,
  loadScheduler
} from '@/lib/pane-manager/pane-terminal-output-scheduler-test-harness'
import { createTerminalStartupTiming } from './terminal-startup-timing'

const record = vi.hoisted(() => vi.fn())
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: record }))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('document', { visibilityState: 'hidden' })
  vi.stubGlobal('localStorage', { getItem: () => '1' })
  record.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function fixture() {
  let render: (() => void) | undefined
  const dispose = vi.fn()
  const timing = createTerminalStartupTiming({
    paneKey: 'tab:pane',
    generation: 1,
    getPtyId: () => 'pty-1',
    isCurrent: () => true,
    isForeground: () => false,
    onRender(callback) {
      render = callback
      return { dispose }
    }
  })
  timing?.mark('connected')
  timing?.mark('liveData')
  return { timing, dispose, render: () => render?.() }
}

function summaries() {
  return record.mock.calls.filter(([name]) => name === 'terminal_startup_timing')
}

it('waits for the final scheduled slice to parse and preserves delivery credit', async () => {
  const { writeTerminalOutput } = await loadScheduler()
  const f = fixture()
  const terminal = createTerminal()
  const callbacks: (() => void)[] = []
  terminal.write.mockImplementation((_data, callback) => {
    if (callback) {
      callbacks.push(callback)
    }
  })
  const credit = vi.fn()
  const payload = 'x'.repeat(20 * 1024)
  writeTerminalOutput(terminal, payload, {
    foreground: false,
    ...f.timing?.firstWrite(),
    ackCredit: credit
  })
  vi.advanceTimersByTime(50)
  expect(terminal.write.mock.calls.map(([data]) => data).join('')).toBe(payload)
  expect(callbacks).toHaveLength(2)
  f.render()
  callbacks[0]()
  expect(summaries()).toHaveLength(0)
  expect(credit).not.toHaveBeenCalled()
  callbacks[1]()
  expect(summaries()).toHaveLength(1)
  expect(summaries()[0][1]).toMatchObject({ outcome: 'observed' })
  expect(credit).toHaveBeenCalledOnce()
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not report a dropped startup batch as parsed when the warning renders', async () => {
  const { writeTerminalOutput } = await loadScheduler()
  const f = fixture()
  const terminal = createTerminal()
  const credit = vi.fn()
  writeTerminalOutput(terminal, 'x'.repeat(512 * 1024), {
    foreground: false,
    ...f.timing?.firstWrite(),
    ackCredit: credit
  })
  for (let i = 0; i < 4; i++) {
    writeTerminalOutput(terminal, 'x'.repeat(512 * 1024), { foreground: false })
  }
  vi.advanceTimersByTime(50)
  expect(terminal.write.mock.calls.map(([data]) => data).join('')).toContain(
    'Orca skipped hidden terminal output'
  )
  f.render()
  expect(summaries()).toHaveLength(0)
  expect(credit).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(10_000)
  expect(summaries()).toHaveLength(1)
  expect(summaries()[0][1]).toMatchObject({ outcome: 'timeout' })
  expect(summaries()[0][1]).not.toHaveProperty('parsed')
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('discards a queued startup write without retaining diagnostics or delivery credit', async () => {
  const { discardTerminalOutput, writeTerminalOutput } = await loadScheduler()
  const f = fixture()
  const terminal = createTerminal()
  const credit = vi.fn()
  writeTerminalOutput(terminal, 'stale', {
    foreground: false,
    ...f.timing?.firstWrite(),
    ackCredit: credit
  })
  f.timing?.finish('disposed')
  discardTerminalOutput(terminal)
  vi.advanceTimersByTime(10_000)
  expect(terminal.write).not.toHaveBeenCalled()
  expect(credit).toHaveBeenCalledOnce()
  expect(summaries()).toHaveLength(1)
  expect(summaries()[0][1]).toMatchObject({ outcome: 'disposed' })
  expect(summaries()[0][1]).not.toHaveProperty('parsed')
  expect(vi.getTimerCount()).toBe(0)
})
