import { afterEach, expect, it, vi } from 'vitest'
import { CodexSubagentPollScheduler } from './codex-subagent-poll-scheduler'

afterEach(() => vi.useRealTimers())
it.each([100, 1000])('rearms %s independent panes without scanning all deadlines', (panes) => {
  vi.useFakeTimers()
  let now = 0
  const due: string[] = []
  const scheduler = new CodexSubagentPollScheduler<string>(
    1000,
    (key, value) => due.push(`${key}:${value}`),
    () => now
  )
  const scan = vi.spyOn(Map.prototype, 'values')
  try {
    for (let i = 0; i < panes; i++) {
      scheduler.schedule(`pane-${i}`, 'old', 1000 + i)
    }
    for (let i = 0; i < panes; i++) {
      scheduler.schedule(`pane-${i}`, 'current', 2000 + i)
    }
    scheduler.clear('pane-0')
    expect(scan).toHaveBeenCalledTimes(0)
    now = 5000
    vi.advanceTimersByTime(5000)
    expect(due).toHaveLength(panes - 1)
    expect(due[0]).toBe('pane-1:current')
    expect(scheduler.size).toBe(0)
  } finally {
    scan.mockRestore()
    scheduler.clearAll()
  }
})
