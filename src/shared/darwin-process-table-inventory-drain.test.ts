import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { lstatMock, opendirMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  opendirMock: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ lstat: lstatMock, opendir: opendirMock }))

import {
  captureDarwinProcessTable,
  resetDarwinProcessTableCaptureForTests
} from './darwin-process-table-capture'

const raw = '123 1 123 123 S+ 16/9 Fri Oct 9 12:34:56 2026 /bin/zsh\n'
const canonical = raw.replace('16/9', 'ttys009')
const capture = vi.fn(async (args: readonly string[]) =>
  args[1].includes('tdev=') ? raw : canonical
)
const validate = (stdout: string): string => stdout
const candidatePath = '/dev/ttys009'
const missingCandidate = (): Promise<never> => Promise.reject(new Error('ENOENT'))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  resetDarwinProcessTableCaptureForTests()
})
afterEach(() => vi.useRealTimers())

describe('Darwin inventory drain admission', () => {
  it('keeps a held stat tracked after an earlier invocation throws synchronously', async () => {
    opendirMock.mockResolvedValue(
      Array.from({ length: 4 }, (_, index) => ({ name: `entry-${index}` }))
    )
    const pending = deferred<{
      rdev: bigint
      isCharacterDevice: () => boolean
    }>()
    lstatMock.mockImplementation((path: string) => {
      if (path === candidatePath) {
        return missingCandidate()
      }
      if (lstatMock.mock.calls.length === 2) {
        throw new Error('stat invocation failed')
      }
      return pending.promise
    })
    const first = captureDarwinProcessTable(capture, validate, 100)
    let settled = false
    void first.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    expect(lstatMock).toHaveBeenCalledTimes(3)
    expect(await captureDarwinProcessTable(capture, validate, 100)).toBe(canonical)
    expect(opendirMock).toHaveBeenCalledTimes(1)

    const stat = { rdev: 0x10000009n, isCharacterDevice: () => true }
    lstatMock.mockResolvedValue(stat)
    pending.resolve(stat)
    expect(await first).toBe(raw.replace('16/9', 'entry-1'))
    expect(lstatMock).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('holds admission until its one uncancelable stat drains and admits no later reads', async () => {
    opendirMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({ name: `entry-${index}` }))
    )
    const pending = deferred<{
      rdev: bigint
      isCharacterDevice: () => boolean
    }>()
    lstatMock.mockImplementation((path: string) =>
      path === candidatePath ? missingCandidate() : pending.promise
    )

    const first = captureDarwinProcessTable(capture, validate, 100)
    const rejected = expect(first).rejects.toThrow('capture_over_budget')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(lstatMock).toHaveBeenCalledTimes(2)
    const stat = { rdev: 0x10000009n, isCharacterDevice: () => true }

    for (let index = 0; index < 5; index++) {
      expect(await captureDarwinProcessTable(capture, validate, 100)).toBe(canonical)
    }
    expect(opendirMock).toHaveBeenCalledTimes(1)
    expect(lstatMock).toHaveBeenCalledTimes(2)

    pending.resolve(stat)
    await vi.advanceTimersByTimeAsync(0)
    expect(lstatMock).toHaveBeenCalledTimes(2)
    lstatMock.mockImplementation(async (path: string) =>
      path === candidatePath ? missingCandidate() : stat
    )
    expect(await captureDarwinProcessTable(capture, validate, 100)).toBe(
      raw.replace('16/9', 'entry-0')
    )
    expect(opendirMock).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('holds admission while an expired pty candidate stat drains', async () => {
    const pending = deferred<{
      rdev: bigint
      isCharacterDevice: () => boolean
    }>()
    lstatMock.mockReturnValue(pending.promise)

    const first = captureDarwinProcessTable(capture, validate, 100)
    const rejected = expect(first).rejects.toThrow('capture_over_budget')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(await captureDarwinProcessTable(capture, validate, 100)).toBe(canonical)
    expect(lstatMock).toHaveBeenCalledTimes(1)
    expect(opendirMock).not.toHaveBeenCalled()

    const stat = { rdev: 0x10000009n, isCharacterDevice: () => true }
    pending.resolve(stat)
    await vi.advanceTimersByTimeAsync(0)
    lstatMock.mockResolvedValue(stat)
    expect(await captureDarwinProcessTable(capture, validate, 100)).toBe(canonical)
    expect(lstatMock).toHaveBeenCalledTimes(2)
    expect(opendirMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes a directory that opens after expiry and holds admission until its close drains', async () => {
    const close = deferred<void>()
    let closeStarted = false
    async function* entries() {
      try {
        yield { name: 'ttys009' }
      } finally {
        closeStarted = true
        await close.promise
      }
    }
    const opened = deferred<AsyncIterable<{ name: string }>>()
    opendirMock.mockReturnValue(opened.promise)
    lstatMock.mockImplementation(missingCandidate)

    const first = captureDarwinProcessTable(capture, validate, 100)
    const rejected = expect(first).rejects.toThrow('capture_over_budget')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    opened.resolve(entries())
    await vi.advanceTimersByTimeAsync(0)
    expect(closeStarted).toBe(true)
    expect(lstatMock.mock.calls).toEqual([[candidatePath, { bigint: true }]])
    expect(await captureDarwinProcessTable(capture, validate, 100)).toBe(canonical)
    expect(opendirMock).toHaveBeenCalledTimes(1)

    close.resolve()
    await vi.advanceTimersByTimeAsync(0)
    opendirMock.mockResolvedValue([{ name: 'fresh-name' }])
    lstatMock.mockImplementation(async (path: string) =>
      path === candidatePath
        ? missingCandidate()
        : { rdev: 0x10000009n, isCharacterDevice: () => true }
    )
    expect(await captureDarwinProcessTable(capture, validate, 100)).toBe(
      raw.replace('16/9', 'fresh-name')
    )
    expect(opendirMock).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
