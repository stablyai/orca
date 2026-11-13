import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { naming } = vi.hoisted(() => ({ naming: vi.fn() }))
vi.mock('./darwin-terminal-names', () => ({ nameDarwinTerminals: naming }))

import {
  captureDarwinProcessTable,
  resetDarwinProcessTableCaptureForTests
} from './darwin-process-table-capture'

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
    expect(await captureDarwinProcessTable(capture, validate, 100)).toBe(canonical)

    finish(raw.replace('16/9', 'stale-name'))
    await pending
    await expect(first).rejects.toThrow('capture_over_budget')
    naming.mockResolvedValue(raw.replace('16/9', 'fresh-name'))
    expect(await captureDarwinProcessTable(capture, validate, 100)).toBe(
      raw.replace('16/9', 'fresh-name')
    )
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
  })
})
