import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { naming } = vi.hoisted(() => ({ naming: vi.fn() }))
vi.mock('./darwin-terminal-names', () => ({ nameDarwinTerminals: naming }))

import {
  captureDarwinProcessTable,
  resetDarwinProcessTableCaptureForTests
} from './darwin-process-table-capture'
import { PS_ARGS } from './process-table-snapshot'

const raw = '123 1 123 123 S+ 16/9 Fri Oct 9 12:34:56 2026 /bin/zsh\n'
const canonical = raw.replace('16/9', 'ttys009')
const validate = (stdout: string): string => stdout
const capture = vi.fn(async (args: readonly string[]) =>
  args[1].includes('tdev=') ? raw : canonical
)

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  resetDarwinProcessTableCaptureForTests()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Darwin translation deadline', () => {
  it('rejects on deadline, refuses new inventory jobs until drain, and discards late names', async () => {
    let finish!: (stdout: string) => void
    const pending = new Promise<string>((resolve) => {
      finish = resolve
    })
    let signal: AbortSignal | undefined
    naming.mockImplementation((_stdout: string, _deps: undefined, current: AbortSignal) => {
      signal = current
      return pending
    })

    const first = captureDarwinProcessTable(capture, validate, 100)
    const rejected = expect(first).rejects.toThrow('capture_over_budget')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(signal?.aborted).toBe(true)
    expect(capture.mock.calls.map(([args]) => args)).toEqual([
      ['-axo', PS_ARGS[1].replace('tty=', 'tdev=')]
    ])
    for (let index = 0; index < 5; index++) {
      expect(await captureDarwinProcessTable(capture, validate, 100)).toBe(canonical)
    }
    expect(naming).toHaveBeenCalledTimes(1)

    finish(raw.replace('16/9', 'stale-name'))
    await pending
    await expect(first).rejects.toThrow('capture_over_budget')
    naming.mockResolvedValue(raw.replace('16/9', 'fresh-name'))
    expect(await captureDarwinProcessTable(capture, validate, 100)).toBe(
      raw.replace('16/9', 'fresh-name')
    )
    expect(naming).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('only gives naming the budget left after ps completes', async () => {
    let finish!: (stdout: string) => void
    const pending = new Promise<string>((resolve) => {
      finish = resolve
    })
    naming.mockReturnValue(pending)
    const slowCapture = vi.fn(async (args: readonly string[]) => {
      if (args[1].includes('tdev=')) {
        await new Promise((resolve) => setTimeout(resolve, 80))
        return raw
      }
      return canonical
    })
    const first = captureDarwinProcessTable(slowCapture, validate, 100)
    const rejected = expect(first).rejects.toThrow('capture_over_budget')
    await vi.advanceTimersByTimeAsync(99)
    expect(slowCapture).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(slowCapture).toHaveBeenCalledTimes(1)
    finish(raw)
    await pending
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start naming after the capture has consumed its budget', async () => {
    const lateCapture = vi.fn(async (args: readonly string[]) => {
      if (args[1].includes('tdev=')) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        return raw
      }
      return canonical
    })

    const first = captureDarwinProcessTable(lateCapture, validate, 100)
    const rejected = expect(first).rejects.toThrow('capture_over_budget')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(naming).not.toHaveBeenCalled()
  })

  it('only gives the canonical fallback the time left after an inventory error', async () => {
    naming.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80))
      throw new Error('directory failed')
    })
    const boundedCapture = vi.fn(async (args: readonly string[], timeoutMs?: number) => {
      expect(timeoutMs).toBe(args[1].includes('tdev=') ? 100 : 20)
      return args[1].includes('tdev=') ? raw : canonical
    })
    const result = captureDarwinProcessTable(boundedCapture, validate, 100)
    await vi.advanceTimersByTimeAsync(80)

    expect(await result).toBe(canonical)
    expect(boundedCapture).toHaveBeenCalledTimes(2)
  })

  it('rejects late successful names even when Promise completion beats the overdue timer', async () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    naming.mockImplementation(async () => {
      await Promise.resolve()
      clock = 101
      return canonical
    })

    await expect(captureDarwinProcessTable(capture, validate, 100)).rejects.toThrow(
      'capture_over_budget'
    )
    expect(capture).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects expiry during output validation without another capture', async () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    naming.mockResolvedValue(canonical)
    const slowValidation = (stdout: string): string => {
      clock = 101
      return stdout
    }

    await expect(captureDarwinProcessTable(capture, slowValidation, 100)).rejects.toThrow(
      'capture_over_budget'
    )
    expect(capture).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
