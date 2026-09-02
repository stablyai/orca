import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { forceTerminateProcessTreeMock, signalProcessTreeMock, spawnMock } = vi.hoisted(() => ({
  forceTerminateProcessTreeMock: vi.fn(),
  signalProcessTreeMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock, spawnSync: vi.fn() }))
vi.mock('./process-tree-termination', () => ({
  forceTerminateProcessTree: forceTerminateProcessTreeMock,
  signalProcessTree: signalProcessTreeMock
}))

import { runProcess } from './run-process'

function mockChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.pid = 1234
  child.kill = vi.fn(() => true)
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child as unknown as ChildProcess
}

describe('runProcess termination failure', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    signalProcessTreeMock.mockResolvedValue(false)
    forceTerminateProcessTreeMock.mockResolvedValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('reports ordinary child close exactly once', async () => {
    const child = mockChild()
    const onChildTerminated = vi.fn()
    spawnMock.mockReturnValue(child)
    const pending = runProcess({ program: 'git', timeoutMs: null, onChildTerminated })

    child.emit('close', 0, null)
    child.emit('close', 0, null)

    await expect(pending).resolves.toMatchObject({ code: 0 })
    expect(onChildTerminated).toHaveBeenCalledOnce()
  })

  it('does not report a live-child error before its eventual close', async () => {
    const child = mockChild()
    const onChildTerminated = vi.fn()
    spawnMock.mockReturnValue(child)
    const pending = runProcess({ program: 'git', timeoutMs: null, onChildTerminated })
    const rejection = expect(pending).rejects.toThrow('delivery failed')

    child.emit('error', new Error('delivery failed'))
    expect(onChildTerminated).not.toHaveBeenCalled()
    child.emit('close', null, 'SIGKILL')

    await rejection
    expect(onChildTerminated).toHaveBeenCalledOnce()
  })

  it('holds the result until the barrier deadline when tree termination cannot be verified', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const pending = runProcess({ program: 'git', timeoutMs: 10, terminationBarrier: true })
    let settled = false
    void pending.then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(settled).toBe(false)
    child.emit('exit', null, 'SIGKILL')

    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toMatchObject({ timedOut: true })
  })

  // Windows takes the taskkill branch, which never consults forceTerminateProcessTree.
  it.skipIf(process.platform === 'win32')(
    'settles without close after forced tree termination is verified',
    async () => {
      forceTerminateProcessTreeMock.mockResolvedValue(true)
      spawnMock.mockReturnValue(mockChild())
      const onChildTerminated = vi.fn()
      const pending = runProcess({
        program: 'git',
        timeoutMs: 10,
        terminationBarrier: true,
        onChildTerminated
      })

      await vi.advanceTimersByTimeAsync(2_010)

      await expect(pending).resolves.toMatchObject({ timedOut: true })
      expect(onChildTerminated).toHaveBeenCalledOnce()
    }
  )

  it('settles on the barrier deadline when the root never reports', async () => {
    const onChildTerminated = vi.fn()
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const pending = runProcess({
      program: 'git',
      timeoutMs: 10,
      terminationBarrier: true,
      onChildTerminated
    })
    let settled = false
    void pending.then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(2_010)
    expect(settled).toBe(false)
    expect(onChildTerminated).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(pending).resolves.toMatchObject({ code: null, timedOut: true })
    expect(onChildTerminated).not.toHaveBeenCalled()
    child.emit('close', null, 'SIGKILL')
    expect(onChildTerminated).toHaveBeenCalledOnce()
  })

  it('retains a root exit observed before barrier shutdown', async () => {
    const controller = new AbortController()
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const pending = runProcess({
      program: 'git',
      timeoutMs: 60_000,
      signal: controller.signal,
      terminationBarrier: true
    })

    child.emit('exit', 0, null)
    controller.abort()
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(pending).resolves.toMatchObject({ code: 0, timedOut: false })
  })

  it('defers a shutdown error until root exit is confirmed', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const pending = runProcess({ program: 'git', timeoutMs: 10, terminationBarrier: true })
    const rejection = expect(pending).rejects.toThrow('kill failed')
    let settled = false
    void pending.catch(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(10)
    child.emit('error', new Error('kill failed'))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(settled).toBe(false)
    child.emit('exit', null, 'SIGKILL')

    await vi.advanceTimersByTimeAsync(10_000)
    await rejection
  })

  it('kills the root when an object barrier cannot verify tree termination', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const pending = runProcess({
      program: 'wsl.exe',
      timeoutMs: 10,
      terminationBarrier: {
        signal: vi.fn().mockResolvedValue(false),
        force: vi.fn().mockResolvedValue(false)
      }
    })
    void pending.catch(() => {})

    await vi.advanceTimersByTimeAsync(2_010)

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.emit('exit', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toMatchObject({ timedOut: true })
  })
})
