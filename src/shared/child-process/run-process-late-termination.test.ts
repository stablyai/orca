import type { ChildProcess } from 'node:child_process'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSpawnedChild } from './__fixtures__/fake-spawned-child'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock, spawnSync: vi.fn() }))

import { runProcess } from './run-process'

function emitCapturedBuffer(child: ChildProcess): WeakRef<Buffer> {
  const chunk = Buffer.alloc(2 * 1024 * 1024, 65)
  child.stdout?.emit('data', chunk)
  return new WeakRef(chunk)
}

describe('runProcess late termination observation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('keeps barrier stderr and late close proof after discarding a settled capture', async () => {
    const child = createFakeSpawnedChild()
    const onChildTerminated = vi.fn()
    const observeStderr = vi.fn()
    spawnMock.mockReturnValue(child)
    const pending = runProcess({
      program: 'wsl.exe',
      timeoutMs: 10,
      onChildTerminated,
      terminationBarrier: {
        observeStderr,
        signal: async () => false,
        force: async () => false
      }
    })
    child.stdout?.emit('data', Buffer.from('captured stdout'))
    await vi.advanceTimersByTimeAsync(12_010)
    await expect(pending).resolves.toMatchObject({ stdout: 'captured stdout', timedOut: true })
    expect(onChildTerminated).not.toHaveBeenCalled()
    expect(child.stdout?.listenerCount('data')).toBe(0)
    const lateMarker = Buffer.from('late process identity')
    child.stderr?.emit('data', lateMarker)
    expect(observeStderr).toHaveBeenCalledWith(lateMarker)
    expect(() => child.emit('error', new Error('late child error'))).not.toThrow()
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      expect(() => stream?.emit('error', new Error('late pipe error'))).not.toThrow()
    }
    child.emit('close', null, 'SIGKILL')
    child.emit('close', null, 'SIGKILL')
    expect(onChildTerminated).toHaveBeenCalledOnce()
    expect(child.stderr?.listenerCount('data')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('discards a rejected live-child capture without reporting termination early', async () => {
    const child = createFakeSpawnedChild()
    const onChildTerminated = vi.fn()
    spawnMock.mockReturnValue(child)
    const pending = runProcess({ program: 'git', timeoutMs: 10_000, onChildTerminated })
    const rejection = expect(pending).rejects.toThrow('delivery failed')
    child.emit('error', new Error('delivery failed'))
    await rejection
    expect(child.stdout?.listenerCount('data')).toBe(0)
    expect(child.stderr?.listenerCount('data')).toBe(0)
    expect(onChildTerminated).not.toHaveBeenCalled()
    expect(() => child.emit('error', new Error('late child error'))).not.toThrow()
    child.emit('close', null, 'SIGKILL')
    expect(onChildTerminated).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases buffers even while a termination attempt still owns its continuation', async () => {
    const child = createFakeSpawnedChild()
    const onChildTerminated = vi.fn()
    let finishSignal = (_confirmed: boolean): void => {}
    const signal = new Promise<boolean>((resolve) => {
      finishSignal = resolve
    })
    spawnMock.mockReturnValue(child)
    const pending = runProcess({
      program: 'wsl.exe',
      timeoutMs: 10,
      onChildTerminated,
      terminationBarrier: { signal: () => signal, force: async () => false }
    })
    const reference = emitCapturedBuffer(child)
    child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(2_010)
    child.emit('close', 0, null)
    await expect(pending).resolves.toMatchObject({ stdout: 'A'.repeat(2 * 1024 * 1024) })
    try {
      if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
        throw new Error('The test runner must enable --expose-gc')
      }
      for (let round = 0; round < 4; round += 1) {
        await nextTurn()
        globalThis.gc()
      }
      expect(reference.deref() === undefined).toBe(true)
    } finally {
      finishSignal(false)
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(onChildTerminated).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
