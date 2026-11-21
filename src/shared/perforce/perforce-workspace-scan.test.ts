import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { P4CommandResult } from './p4-command'
import {
  HELD_SCAN_MESSAGE,
  holdWorkspaceScansUnder,
  invalidateWorkspaceScan,
  isWorkspaceScanHeld,
  resetWorkspaceScansForTests,
  scanWorkspace
} from './perforce-workspace-scan'

const WS = process.platform === 'win32' ? 'D:\\ws' : '/ws'
const COPY = process.platform === 'win32' ? 'D:\\ws.wt\\one' : '/ws.wt/one'

/** A scan that finishes when the test says so, or when aborted. */
function controllableScans() {
  const runs: {
    signal: AbortSignal
    finish: (stdout: string) => void
    timeOut: () => void
  }[] = []
  const run = (signal: AbortSignal): Promise<P4CommandResult> =>
    new Promise((resolve, reject) => {
      const finish = (stdout: string) => resolve({ code: 0, stdout, stderr: '' })
      const timeOut = () => reject(new Error('p4 reconcile timed out'))
      signal.addEventListener('abort', () => resolve({ code: null, stdout: '', stderr: 'aborted' }))
      runs.push({ signal, finish, timeOut })
    })
  return { runs, run }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  resetWorkspaceScansForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('scanWorkspace', () => {
  it('runs one scan at a time and answers later calls from it until it has rested', async () => {
    const { runs, run } = controllableScans()
    const first = scanWorkspace(WS, 15_000, run)
    const second = scanWorkspace(WS, 15_000, run)
    expect(runs).toHaveLength(1)
    vi.advanceTimersByTime(10_000)
    runs[0].finish('scan 1')
    expect((await first).stdout).toBe('scan 1')
    expect((await second).stdout).toBe('scan 1')

    // Rests 3 x 10 s after a 10 s scan.
    vi.advanceTimersByTime(29_000)
    expect((await scanWorkspace(WS, 15_000, run)).stdout).toBe('scan 1')
    expect(runs).toHaveLength(1)

    vi.advanceTimersByTime(1_000)
    expect((await scanWorkspace(WS, 15_000, run)).stdout).toBe('scan 1')
    expect(runs).toHaveLength(2)
    expect((await scanWorkspace(WS, 15_000, run)).stdout).toBe('scan 1')
    expect(runs).toHaveLength(2)
    runs[1].finish('scan 2')
    await Promise.resolve()
    expect((await scanWorkspace(WS, 15_000, run)).stdout).toBe('scan 2')
  })

  it('rests after a timed-out scan, answering from the last good one meanwhile', async () => {
    const { runs, run } = controllableScans()
    const first = scanWorkspace(WS, 15_000, run)
    runs[0].finish('good')
    await first
    vi.advanceTimersByTime(15_000)
    await scanWorkspace(WS, 15_000, run)
    vi.advanceTimersByTime(20_000)
    runs[1].timeOut()
    await Promise.resolve()
    await Promise.resolve()

    // Rests 3 x 20 s after a 20 s scan that timed out, even when Orca changed what is opened.
    invalidateWorkspaceScan(WS)
    vi.advanceTimersByTime(59_000)
    expect((await scanWorkspace(WS, 15_000, run)).stdout).toBe('good')
    expect(runs).toHaveLength(2)
    vi.advanceTimersByTime(1_000)
    await scanWorkspace(WS, 15_000, run)
    expect(runs).toHaveLength(3)
  })

  it("reports a folder's failed first scan until it has rested, then scans again", async () => {
    const { runs, run } = controllableScans()
    const first = scanWorkspace(WS, 15_000, run)
    vi.advanceTimersByTime(10_000)
    runs[0].timeOut()
    await expect(first).rejects.toThrow('timed out')
    await expect(scanWorkspace(WS, 15_000, run)).rejects.toThrow('timed out')
    expect(runs).toHaveLength(1)
    vi.advanceTimersByTime(30_000)
    const retry = scanWorkspace(WS, 15_000, run)
    expect(runs).toHaveLength(2)
    runs[1].finish('scanned')
    expect((await retry).stdout).toBe('scanned')
  })

  it('rescans after Orca changes what is opened, without waiting for it', async () => {
    const { runs, run } = controllableScans()
    const first = scanWorkspace(WS, 15_000, run)
    runs[0].finish('before')
    await first
    invalidateWorkspaceScan(WS)
    vi.advanceTimersByTime(1)
    expect((await scanWorkspace(WS, 15_000, run)).stdout).toBe('before')
    expect(runs).toHaveLength(2)
  })

  it('stops scans in a copy being deleted and refuses new ones until released', async () => {
    const { runs, run } = controllableScans()
    const scanning = scanWorkspace(COPY, 15_000, run)
    const release = await holdWorkspaceScansUnder(COPY)
    expect(runs[0].signal.aborted).toBe(true)
    await scanning
    expect(isWorkspaceScanHeld(COPY)).toBe(true)
    expect(isWorkspaceScanHeld(WS)).toBe(false)
    expect((await scanWorkspace(COPY, 15_000, run)).stderr).toBe(HELD_SCAN_MESSAGE)
    expect(runs).toHaveLength(1)

    release()
    expect(isWorkspaceScanHeld(COPY)).toBe(false)
    void scanWorkspace(COPY, 15_000, run)
    expect(runs).toHaveLength(2)
  })
})
