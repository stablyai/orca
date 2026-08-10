import type * as ChildProcessModule from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return { ...actual, spawn: spawnMock }
})

import { terminateSpawnedChild, WSL_TREE_KILL_TIMEOUT_MS } from './spawned-child-cancellation'

const originalPlatform = process.platform

function mockChild(pid: number | undefined, spawnfile: string): ChildProcessModule.ChildProcess {
  const child = new EventEmitter() as ChildProcessModule.ChildProcess
  Object.assign(child, { pid, spawnfile, kill: vi.fn(), unref: vi.fn() })
  return child
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  vi.useRealTimers()
  spawnMock.mockReset()
})

describe('terminateSpawnedChild WSL cleanup', () => {
  it('deduplicates Windows tree termination for a WSL wrapper', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const child = mockChild(1234, 'C:\\Windows\\System32\\WSL.EXE')
    const killer = mockChild(5678, 'taskkill')
    spawnMock.mockReturnValue(killer)

    terminateSpawnedChild(child)
    terminateSpawnedChild(child)

    expect(spawnMock).toHaveBeenCalledOnce()
    expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
    expect(child.kill).not.toHaveBeenCalled()
    killer.emit('close', 0)
  })

  it.each(['error', 'nonzero-close'] as const)(
    'falls back to direct termination after taskkill %s',
    (failure) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const child = mockChild(1234, 'wsl.exe')
      const killer = mockChild(5678, 'taskkill')
      spawnMock.mockReturnValue(killer)

      terminateSpawnedChild(child)
      if (failure === 'error') {
        killer.emit('error', new Error('taskkill unavailable'))
      } else {
        killer.emit('close', 1)
      }

      expect(child.kill).toHaveBeenCalledOnce()
    }
  )

  it('falls back safely when Windows tree termination times out', async () => {
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const child = mockChild(1234, 'wsl.exe')
    const killer = mockChild(5678, 'taskkill')
    spawnMock.mockReturnValue(killer)

    terminateSpawnedChild(child)
    await vi.advanceTimersByTimeAsync(WSL_TREE_KILL_TIMEOUT_MS)

    expect(killer.kill).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('terminates a native Windows child directly', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const child = mockChild(1234, 'C:\\tools\\rg.exe')

    terminateSpawnedChild(child)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('never tree-kills a WSL wrapper before spawn assigns a pid', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const child = mockChild(undefined, 'wsl.exe')

    terminateSpawnedChild(child)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    child.emit('error', new Error('spawn wsl.exe ENOENT'))
    expect(child.listenerCount('error')).toBe(0)
  })
})
