import { afterEach, expect, it, vi } from 'vitest'
import { probePtyRunningWorkWithInspection } from './pty-running-work-probe'
import type { TerminalProcessInspection } from './terminal-process-inspection'

afterEach(() => vi.useRealTimers())

it('keeps thrown inspections unverifiable and clears the deadline once all answer', async () => {
  vi.useFakeTimers()
  const inspect = vi.fn(async () => {
    throw new Error('host unavailable')
  })
  const [probe] = await probePtyRunningWorkWithInspection(
    ['local-pty'],
    { timeoutMs: 1000 },
    inspect
  )
  expect(probe).toEqual({
    ptyId: 'local-pty',
    verdict: 'unverifiable',
    reason: 'probe_failed',
    timedOut: false,
    remote: false
  })
  expect(vi.getTimerCount()).toBe(0)
})

it('retains input order and unobserved verdicts when only some hosts answer before the deadline', async () => {
  vi.useFakeTimers()
  const pending = Promise.withResolvers<TerminalProcessInspection>()
  const inspect = vi
    .fn<(ptyId: string) => Promise<TerminalProcessInspection>>()
    .mockResolvedValueOnce({
      foregroundProcess: 'zsh',
      hasChildProcesses: true,
      childProcessEvidence: 'children'
    })
    .mockReturnValueOnce(pending.promise)
  const probing = probePtyRunningWorkWithInspection(
    ['local-pty', 'remote:owner:pty'],
    { timeoutMs: 10 },
    inspect
  )
  await vi.advanceTimersByTimeAsync(10)
  const probes = await probing
  expect(probes).toEqual([
    {
      ptyId: 'local-pty',
      verdict: 'live',
      timedOut: false,
      remote: false,
      foregroundProcess: 'zsh'
    },
    {
      ptyId: 'remote:owner:pty',
      verdict: 'unverifiable',
      reason: 'probe_deadline',
      timedOut: true,
      remote: true
    }
  ])
  expect(inspect).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
  pending.resolve({
    foregroundProcess: 'zsh',
    hasChildProcesses: false,
    childProcessEvidence: 'no-children'
  })
  await pending.promise
})
