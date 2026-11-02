import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as PresenceProbe from './agent-process-presence-probe'
import type { AgentProcessObservation } from './agent-process-presence-probe'
import type { AgentProcessIdentity } from './agent-process-presence'
import { createLocalHookRootEvidenceReader } from './hook-process-root-evidence-reader'
import type { HookRootEvidenceRequest } from './hook-process-root-evidence'
import { PrioritySemaphore } from './priority-semaphore'
import { readSelectedRows } from './tmux-host-attachment-probe'

// Counts every subprocess or proc read in flight, the executor resource the cap protects.
const io = vi.hoisted(() => ({ active: 0, peak: 0, fail: new Set<number>() }))
async function occupy<T>(result: () => T): Promise<T> {
  io.active++
  io.peak = Math.max(io.peak, io.active)
  // Yield to the event loop so overlapping reads are counted while they run.
  await new Promise((resolve) => setTimeout(resolve, 0))
  io.active--
  return result()
}

const START = 'Sun Nov  1 00:00:00 2026'
// The suite skips Windows; a process here runs on one of the platforms the reader verifies.
const PLATFORM: AgentProcessIdentity['platform'] = process.platform === 'linux' ? 'linux' : 'darwin'
// Pane i: login root 1000+10i, its shell, and Claude in the foreground on ttys<i>.
function paneRows(pane: number): string[] {
  const root = 1000 + pane * 10
  const tty = `ttys${pane}`
  return [
    `${root} 1 ${root} ${root + 2} Ss ${tty} 5 /usr/bin/login -flpq u /bin/zsh`,
    `${root + 1} ${root} ${root + 1} ${root + 2} S ${tty} 5 -zsh`,
    `${root + 2} ${root + 1} ${root + 2} ${root + 2} S+ ${tty} 5 claude`
  ]
}
function psOutput(args: readonly string[]): string {
  const [flag, value] = args
  const panes = Array.from({ length: 100 }, (_, pane) => paneRows(pane)).flat()
  if (flag === '-t') {
    return panes.filter((line) => line.split(/\s+/)[5] === value).join('\n')
  }
  const pid = Number(value)
  if (io.fail.has(pid)) {
    throw new Error('ps failed')
  }
  return panes.filter((line) => Number(line.split(/\s+/)[0]) === pid).join('\n')
}

vi.mock('./libproc-process-table', () => ({
  runPsInProcess: (args: readonly string[]) =>
    occupy(() => ({ code: 0, signal: null, stdout: psOutput(args), stderr: '', timedOut: false }))
}))
vi.mock('./agent-process-presence-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof PresenceProbe>()),
  readAgentProcess: () =>
    occupy((): AgentProcessObservation => ({ verdict: 'live', startTime: START, zombie: false }))
}))

afterEach(() => {
  io.peak = 0
  io.fail.clear()
})

function request(pane: number, signal?: AbortSignal): HookRootEvidenceRequest {
  return {
    paneKey: `pane-${pane}`,
    worktreeId: 'wt-1',
    agent: 'claude',
    process: {
      pid: 1000 + pane * 10 + 2,
      platform: PLATFORM,
      startTime: START
    },
    ...(signal ? { signal } : {})
  }
}

const reader = (slots?: PrioritySemaphore) =>
  createLocalHookRootEvidenceReader(
    async (paneKey) => ({ pid: 1000 + Number(paneKey.slice(5)) * 10, incarnation: 'inc' }),
    slots
  )

describe.skipIf(process.platform === 'win32')('acquisition reads across panes', () => {
  it.each([[10], [100]])(
    'run at most four subprocess or proc reads at once for %i panes, and every pane proves',
    async (panes) => {
      const read = reader()
      const results = await Promise.all(
        Array.from({ length: panes }, (_, pane) => read(request(pane)))
      )
      expect(io.peak).toBeLessThanOrEqual(4)
      expect(results.every((result) => result?.verdict === 'root')).toBe(true)
    }
  )

  it('bounds a reader’s own per-PID fanout by the same slots', async () => {
    const slots = new PrioritySemaphore(4)
    const gate = async <T>(work: () => Promise<T>): Promise<T> => {
      const release = await slots.acquire(0)
      try {
        return await work()
      } finally {
        release()
      }
    }
    const pids = Array.from({ length: 40 }, (_, pane) => 1000 + pane * 10)
    expect(await readSelectedRows(pids, gate)).toHaveLength(40)
    expect(io.peak).toBeLessThanOrEqual(4)
  })

  it('releases slots after a failed read and gives up queued reads once expired', async () => {
    const slots = new PrioritySemaphore(4)
    const read = reader(slots)
    io.fail.add(1000)
    expect((await read(request(0)))?.verdict).toBe('unknown')
    const expired = new AbortController()
    expired.abort()
    expect((await read(request(1, expired.signal)))?.verdict).toBe('unknown')
    // Every slot came back: a later pane still proves.
    expect((await read(request(2)))?.verdict).toBe('root')
  })
})
