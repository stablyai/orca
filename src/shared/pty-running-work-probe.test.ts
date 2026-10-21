import { afterEach, expect, it, vi } from 'vitest'
import { probePtyRunningWorkWithInspection } from './pty-running-work-probe'
import {
  clientOnlyUnverifiableInspection,
  type TerminalProcessInspection
} from './terminal-process-inspection'

afterEach(() => vi.useRealTimers())

it('returns immediately for no terminals without asking an execution host', async () => {
  const inspect = vi.fn<(ptyId: string) => Promise<TerminalProcessInspection>>()
  expect(await probePtyRunningWorkWithInspection([], { timeoutMs: 1000 }, inspect)).toEqual([])
  expect(inspect).not.toHaveBeenCalled()
})

it.each([
  [
    { foregroundProcess: 'zsh', hasChildProcesses: true, childProcessEvidence: 'children' },
    'live',
    undefined
  ],
  [
    { foregroundProcess: 'zsh', hasChildProcesses: false, childProcessEvidence: 'no-children' },
    'exited',
    undefined
  ],
  [
    { foregroundProcess: 'zsh', hasChildProcesses: false, childProcessEvidence: 'unverifiable' },
    'unverifiable',
    'host_child_processes_unobserved'
  ],
  [clientOnlyUnverifiableInspection('transport_loss'), 'unverifiable', 'transport_loss'],
  [{ foregroundProcess: 'zsh', hasChildProcesses: true }, 'live', undefined],
  [{ foregroundProcess: 'zsh', hasChildProcesses: false }, 'exited', undefined]
] as const)(
  'keeps the existing owning-host verdict for %j',
  async (inspection, verdict, reason) => {
    const inspect = vi.fn(async () => inspection)
    const [probe] = await probePtyRunningWorkWithInspection(
      ['remote:owner:pty'],
      { timeoutMs: 1000 },
      inspect
    )
    expect(probe).toEqual({
      ptyId: 'remote:owner:pty',
      verdict,
      ...(reason ? { reason } : {}),
      timedOut: false,
      remote: true
    })
    expect(inspect).toHaveBeenCalledWith('remote:owner:pty')
  }
)

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
    { ptyId: 'local-pty', verdict: 'live', timedOut: false, remote: false },
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
