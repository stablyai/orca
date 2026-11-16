import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentProcessExitWatch } from './agent-process-exit-watch'
import type { AgentProcessVerdict } from './agent-process-presence'

type Verdict = AgentProcessVerdict | null

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
})

afterEach(() => {
  vi.useRealTimers()
})

it('keeps a restarted watch when the earlier probe settles late', async () => {
  const watch = new AgentProcessExitWatch()
  let settle: (verdict: Verdict) => void = () => {}
  const stale = vi.fn(() => new Promise<Verdict>((resolve) => (settle = resolve)))
  const fresh = vi.fn(async (): Promise<Verdict> => 'live')
  watch.start('pane', { probe: stale, isCurrent: () => true })
  await vi.advanceTimersByTimeAsync(250)

  watch.start('pane', { probe: fresh, isCurrent: () => true })
  settle('live')
  await vi.advanceTimersByTimeAsync(250)

  expect(stale).toHaveBeenCalledOnce()
  expect(fresh).toHaveBeenCalledOnce()
})
