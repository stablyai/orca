import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { forceTerminateProcessTree } from './process-tree-termination'

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
          stdout.emit('data', Buffer.from('1234 1234 D\n'))
          probe.emit('close', 0)
        })
        return probe
      })

      const pending = forceTerminateProcessTree(mockProcess(1234))
      await vi.advanceTimersByTimeAsync(2_100)

      await expect(pending).resolves.toBe(false)
    }
  )

  // A gate child that calls setsid() leaves the process group, so the -pgid
  // signal never reaches it and it keeps holding the worktree.
  describe.skipIf(process.platform === 'win32')('setsid escapees', () => {
    function stubPs(rows: (args: readonly string[]) => string): void {
      spawnMock.mockImplementation((_command: string, args: readonly string[]) => {
        const probe = mockProcess(5678)
        const stdout = new EventEmitter()
        Object.defineProperty(probe, 'stdout', { value: stdout })
        queueMicrotask(() => {
          stdout.emit('data', Buffer.from(rows(args)))
          probe.emit('close', 0)
        })
        return probe
      })
    }

    it('signals each descendant the process group signal cannot reach', async () => {
      const killed: number[] = []
      vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
        killed.push(pid)
        return true
      })
      stubPs((args) =>
        args.includes('pid=,ppid=')
          ? '2000 1234\n3000 2000\n4000 999\n'
          : // Both escapees reaped; nothing left in the group.
            ''
      )

      await expect(forceTerminateProcessTree(mockProcess(1234))).resolves.toBe(true)
      expect(killed).toContain(-1234)
      expect(killed).toContain(2000)
      expect(killed).toContain(3000)
      // An unrelated process that is not a descendant is never signalled.
      expect(killed).not.toContain(4000)
    })

    it('refuses quiescence while an escapee in another group is still alive', async () => {
      vi.useFakeTimers()
      vi.spyOn(process, 'kill').mockImplementation(() => true)
      stubPs((args) =>
        args.includes('pid=,ppid=')
          ? '2000 1234\n'
          : // pgid 9999 is NOT the killed group: only the escapee snapshot can
            // prove this row belongs to the tree.
            '2000 9999 S\n'
      )

      const pending = forceTerminateProcessTree(mockProcess(1234))
      await vi.advanceTimersByTimeAsync(2_100)

      await expect(pending).resolves.toBe(false)
    })
  })
})
