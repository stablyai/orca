import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { forceTerminateProcessTree, signalProcessTree } from './process-tree-termination'
import { setProcessTreeKillObserver, type ProcessTreeKill } from './process-tree-kill-observer'

function mockProcess(pid: number): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    kill: ReturnType<typeof vi.fn>
  }
  child.pid = pid
  child.kill = vi.fn((_signal?: NodeJS.Signals | number) => true)
  return child as unknown as ChildProcess
}

async function withWindows(run: () => Promise<void>): Promise<void> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    await run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('forceTerminateProcessTree', () => {
  afterEach(() => {
    spawnMock.mockReset()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('waits for Windows taskkill tree completion', async () => {
    await withWindows(async () => {
      const child = mockProcess(1234)
      const taskkill = mockProcess(5678)
      spawnMock.mockReturnValue(taskkill)
      let settled = false
      const pending = forceTerminateProcessTree(child)
      void pending.then(() => {
        settled = true
      })

      await Promise.resolve()
      expect(settled).toBe(false)
      expect(spawnMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '1234', '/t', '/f'],
        expect.objectContaining({ shell: false, windowsHide: true })
      )

      taskkill.emit('close', 0)
      await expect(pending).resolves.toBe(true)
      expect(child.kill).not.toHaveBeenCalled()
    })
  })

  it('falls back to the root when Windows tree termination fails', async () => {
    await withWindows(async () => {
      const child = mockProcess(1234)
      const taskkill = mockProcess(5678)
      spawnMock.mockReturnValue(taskkill)
      const pending = forceTerminateProcessTree(child)

      taskkill.emit('close', 1)
      await expect(pending).resolves.toBe(false)
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    })
  })

  it.skipIf(process.platform === 'win32')(
    'stops waiting when a POSIX process group cannot become quiescent',
    async () => {
      vi.useFakeTimers()
      vi.spyOn(process, 'kill').mockImplementation(() => true)
      spawnMock.mockImplementation(() => {
        const probe = mockProcess(5678)
        const stdout = new EventEmitter()
        Object.defineProperty(probe, 'stdout', { value: stdout })
        queueMicrotask(() => {
          stdout.emit('data', Buffer.from('1234 D\n'))
          probe.emit('close', 0)
        })
        return probe
      })

      const pending = forceTerminateProcessTree(mockProcess(1234))
      await vi.advanceTimersByTimeAsync(2_100)

      await expect(pending).resolves.toBe(false)
    }
  )
})

describe('process-tree-kill breadcrumb seam', () => {
  const observed: ProcessTreeKill[] = []

  beforeEach(() => {
    observed.length = 0
    setProcessTreeKillObserver((kill) => observed.push(kill))
  })

  afterEach(() => {
    setProcessTreeKillObserver(null)
    spawnMock.mockReset()
    vi.restoreAllMocks()
  })

  it('reports the Windows taskkill tree it just spawned', async () => {
    await withWindows(async () => {
      const child = mockProcess(1234)
      const taskkill = mockProcess(5678)
      spawnMock.mockReturnValue(taskkill)

      const pending = signalProcessTree(child, 'SIGKILL')
      taskkill.emit('close', 0)
      await pending

      expect(observed).toEqual([
        { pid: 1234, site: 'run-process-tree', scope: 'win-taskkill-tree' }
      ])
    })
  })

  it.skipIf(process.platform === 'win32')(
    'reports the POSIX process group it signalled',
    async () => {
      vi.spyOn(process, 'kill').mockImplementation(() => true)

      await expect(signalProcessTree(mockProcess(1234), 'SIGKILL')).resolves.toBe(true)

      expect(observed).toEqual([
        { pid: 1234, site: 'run-process-tree', scope: 'posix-process-group' }
      ])
    }
  )

  it('never taskkills a pid the child already gave back to Windows', async () => {
    await withWindows(async () => {
      // A reaped pid is Windows' to reissue, and this host may be the daemon or
      // relay, where the main-process own-Chromium guard cannot run.
      const child = mockProcess(1234) as ChildProcess & { exitCode: number }
      child.exitCode = 0

      // `false`, not `true`: a taskkill against a reaped pid already resolved to
      // `false`, and reporting verified termination here would release the git
      // admission grant on root exit instead of on `close`.
      await expect(signalProcessTree(child, 'SIGKILL')).resolves.toBe(false)

      expect(spawnMock).not.toHaveBeenCalled()
      expect(observed).toEqual([])
    })
  })
})
