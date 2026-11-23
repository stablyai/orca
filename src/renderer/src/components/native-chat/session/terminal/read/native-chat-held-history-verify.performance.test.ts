import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { withHeldOlderHistory } from '../../../viewport/history/native-chat-pagination'
import { NativeChatHeldHistoryVerify } from './native-chat-held-history-verify'
import {
  rereadNativeChatHeldHistory,
  spliceHeldHistoryReread
} from './native-chat-held-history-reread'
import type { NativeChatSessionTransport } from './native-chat-session-transport'
import type { NativeChatReadSessionResult } from '../../../../../../../preload/api/native-chat/native-chat-api'
import type {
  TranscriptByteRange,
  TranscriptRangeVerification
} from '../../../../../../../shared/native-chat/transcript/transcript-byte-range'

// PR #45168: retained history must not multiply filesystem work during replacement bursts.
describe.each([
  { count: 10_000, reads: 5, firstCursor: 8_000 },
  { count: 100_000, reads: 50, firstCursor: 98_000 }
])('held-history verification at $count rows', ({ count, reads, firstCursor }) => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function history(
    verify?: (
      ranges: TranscriptByteRange[],
      signal: AbortSignal
    ) => Promise<TranscriptRangeVerification | null>,
    readDelayMs = 0,
    onApplied: () => void = () => {}
  ) {
    const held: NativeChatMessage[] = Array.from({ length: count }, (_, n) => ({
      id: `row-${n}`,
      role: 'user',
      blocks: [{ type: 'text', text: `row-${n}` }],
      timestamp: 1,
      source: 'transcript',
      transcriptOrder: n
    }))
    const windowRows = held.slice(-300)
    const window = [{ start: count - 300, end: count, digest: '0000000000000300' }]
    const readSession = vi.fn<NativeChatSessionTransport['readSession']>(
      async (_agent, _sessionId, _limit, _path, options) => {
        if (readDelayMs > 0) {
          // ast-grep-ignore: test-no-real-time-wait -- fake timers advance this simulated page read
          await new Promise((resolve) => setTimeout(resolve, readDelayMs))
        }
        const end = options?.beforeOffset ?? count
        const start = Math.max(0, end - 2_000)
        return {
          messages: held.slice(start, end),
          ranges: [{ start, end, digest: '0000000000000100' }],
          hasMore: start > 0
        }
      }
    )
    const transport: NativeChatSessionTransport = { readSession, subscribe: () => () => {} }
    let current = held
    const apply = vi.fn((result: NativeChatReadSessionResult | undefined, superseded: boolean) => {
      if (!result || !('messages' in result)) {
        current = windowRows
        return undefined
      }
      const spliced = superseded
        ? spliceHeldHistoryReread(
            'claude',
            result.messages,
            { phase: 'ready', messages: current },
            windowRows[0]
          )
        : result.messages
      if (!spliced) {
        return false
      }
      current = spliced
      onApplied()
      return result.ranges
    })
    const scheduler = new NativeChatHeldHistoryVerify({
      visible: () => true,
      olderSpan: () => ({ start: current[0]!.transcriptOrder!, end: count - 300 }),
      verify,
      reread: (signal) =>
        rereadNativeChatHeldHistory(transport, 'claude', 'session', undefined, count, 300, signal),
      apply
    })
    scheduler.reset(window)
    scheduler.prepend([{ start: 0, end: count - 300, digest: '0000000000000200' }])
    const replace = (withRanges = true): void => {
      const base = scheduler.supported
        ? withHeldOlderHistory(
            'claude',
            { phase: 'ready', messages: current },
            [],
            windowRows,
            true
          )
        : windowRows
      current = base
      scheduler.replacement(withRanges ? window : undefined, base !== windowRows)
    }
    return { scheduler, replace, readSession, apply, held, current: () => current, windowRows }
  }

  it('verifies once after fifty replacements go quiet', async () => {
    const verify = vi.fn().mockResolvedValue([true])
    const { scheduler, replace, readSession } = history(verify)
    try {
      for (let i = 0; i < 50; i++) {
        replace()
        await vi.advanceTimersByTimeAsync(10)
      }
      await vi.advanceTimersByTimeAsync(1_000)
      expect(verify).toHaveBeenCalledTimes(1)
      expect(readSession).toHaveBeenCalledTimes(0)
    } finally {
      scheduler.clear()
    }
  })

  it('repairs a mismatch with one EOF read and backward pages to the held depth', async () => {
    const verify = vi.fn().mockResolvedValue([false])
    const { scheduler, replace, readSession, apply, current } = history(verify)
    try {
      replace()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(verify).toHaveBeenCalledTimes(1)
      expect(readSession).toHaveBeenCalledTimes(reads)
      expect(readSession).toHaveBeenNthCalledWith(
        1,
        'claude',
        'session',
        count,
        undefined,
        undefined
      )
      expect(readSession).toHaveBeenNthCalledWith(2, 'claude', 'session', count, undefined, {
        beforeOffset: firstCursor
      })
      expect(readSession).toHaveBeenLastCalledWith('claude', 'session', count, undefined, {
        beforeOffset: 2_000
      })
      expect(apply).toHaveBeenCalledTimes(1)
      expect(current()).toHaveLength(count)
      expect(current()[0]?.id).toBe('row-0')
    } finally {
      scheduler.clear()
    }
  })

  it('applies one re-read while replacements keep landing every 2.5 s after a mismatch', async () => {
    let repaired = false
    const verify = vi.fn(async () => [repaired])
    const { scheduler, replace, readSession, apply, current } = history(verify, 100, () => {
      repaired = true
    })
    try {
      for (let i = 0; i < 8; i++) {
        replace()
        await vi.advanceTimersByTimeAsync(2_500)
      }
      await vi.advanceTimersByTimeAsync(10_000)
      const eofReads = readSession.mock.calls.filter(([, , , , options]) => !options)
      expect(eofReads).toHaveLength(1)
      expect(apply.mock.results.filter(({ value }) => Array.isArray(value))).toHaveLength(1)
      expect(current()).toHaveLength(count)
      expect(current()[0]?.id).toBe('row-0')
    } finally {
      scheduler.clear()
    }
  })

  it('verifies once more after quiet when touches during a verify leave it unsettled', async () => {
    const verify = vi.fn(async (): Promise<'unsettled' | boolean[]> => {
      // ast-grep-ignore: test-no-real-time-wait -- fake timers advance this simulated verify
      await new Promise((resolve) => setTimeout(resolve, 500))
      return verify.mock.calls.length === 1 ? 'unsettled' : [true]
    })
    const { scheduler, replace, readSession } = history(verify)
    try {
      replace()
      await vi.advanceTimersByTimeAsync(1_000)
      for (let i = 0; i < 3; i++) {
        replace()
        await vi.advanceTimersByTimeAsync(200)
      }
      await vi.advanceTimersByTimeAsync(10_000)
      expect(verify).toHaveBeenCalledTimes(2)
      expect(readSession).toHaveBeenCalledTimes(0)
    } finally {
      scheduler.clear()
    }
  })

  it('stops timed re-checks of a file that never settles until the next transcript frame', async () => {
    const verify = vi.fn(async (): Promise<'unsettled' | boolean[]> => 'unsettled')
    const { scheduler, replace, readSession } = history(verify)
    try {
      replace()
      await vi.advanceTimersByTimeAsync(600_000)
      expect(verify).toHaveBeenCalledTimes(4)
      replace()
      await vi.advanceTimersByTimeAsync(600_000)
      expect(verify).toHaveBeenCalledTimes(5)
      scheduler.append([{ start: count, end: count + 1, digest: '0000000000000001' }])
      await vi.advanceTimersByTimeAsync(600_000)
      expect(verify).toHaveBeenCalledTimes(6)
      expect(readSession).toHaveBeenCalledTimes(0)
    } finally {
      scheduler.clear()
    }
  })

  it('coalesces reconnect windows without ranges into one matching verification', async () => {
    const verify = vi.fn().mockResolvedValue([true])
    const { scheduler, replace, readSession, held, current } = history(verify)
    try {
      for (let i = 0; i < 50; i++) {
        replace(false)
        await vi.advanceTimersByTimeAsync(10)
      }
      await vi.advanceTimersByTimeAsync(1_000)
      expect(verify).toHaveBeenCalledTimes(1)
      expect(readSession).toHaveBeenCalledTimes(0)
      expect(current()).toBe(held)
    } finally {
      scheduler.clear()
    }
  })

  it.each(['absent', 'unsupported'])(
    'resets %s verification to the window without rereading',
    async (kind) => {
      const verify = vi.fn().mockResolvedValue(null)
      const { scheduler, replace, readSession, current, windowRows } = history(
        kind === 'absent' ? undefined : verify
      )
      try {
        replace()
        await vi.advanceTimersByTimeAsync(1_000)
        expect(current()).toBe(windowRows)
        verify.mockClear()
        for (let i = 0; i < 50; i++) {
          replace()
          await vi.advanceTimersByTimeAsync(10)
        }
        await vi.advanceTimersByTimeAsync(1_000)
        expect(verify).toHaveBeenCalledTimes(0)
        expect(readSession).toHaveBeenCalledTimes(0)
        expect(current()).toBe(windowRows)
      } finally {
        scheduler.clear()
      }
    }
  )

  it('allows one running verification and one follow-up', async () => {
    let active = 0
    let maximum = 0
    let finish: (result: boolean[]) => void = () => {}
    const verify = vi.fn(async () => {
      active++
      maximum = Math.max(maximum, active)
      try {
        return await new Promise<boolean[]>((resolve) => {
          finish = resolve
        })
      } finally {
        active--
      }
    })
    const { scheduler, replace, readSession } = history(verify)
    try {
      replace()
      await vi.advanceTimersByTimeAsync(1_000)
      replace()
      await vi.advanceTimersByTimeAsync(1_000)
      finish([true])
      await vi.advanceTimersByTimeAsync(0)
      finish([true])
      await vi.advanceTimersByTimeAsync(0)
      expect(maximum).toBe(1)
      expect(verify).toHaveBeenCalledTimes(2)
      expect(readSession).toHaveBeenCalledTimes(0)
    } finally {
      scheduler.clear()
    }
  })
})

describe('held-history verification under sliding windows', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const digest = '0000000000000001'

  it('keeps each verification within twice the held span while appends and replacements alternate', async () => {
    let end = 300
    const hashed: number[] = []
    const verify = vi.fn(async (ranges: TranscriptByteRange[]) => {
      hashed.push(ranges.reduce((sum, range) => sum + range.end - range.start, 0))
      return ranges.map(() => true)
    })
    const scheduler = new NativeChatHeldHistoryVerify<TranscriptByteRange[]>({
      visible: () => true,
      olderSpan: () => ({ start: Math.max(0, end - 900), end: end - 300 }),
      verify,
      reread: async () => [{ start: Math.max(0, end - 900), end, digest }],
      apply: (ranges) => ranges
    })
    try {
      scheduler.reset([{ start: 0, end, digest }])
      for (let k = 0; k < 5_000; k++) {
        scheduler.append([{ start: end, end: end + 1, digest }])
        end++
        scheduler.replacement([{ start: end - 300, end, digest }], true)
        await vi.advanceTimersByTimeAsync(1_000)
      }
      expect(Math.max(...hashed)).toBeLessThanOrEqual(2_100)
    } finally {
      scheduler.clear()
    }
  })

  it('keeps hashing bounded while appends during each unsettled check stretch the proof', async () => {
    let end = 500
    const hashed: number[] = []
    const verify = vi.fn(async (ranges: TranscriptByteRange[]) => {
      hashed.push(ranges.reduce((sum, range) => sum + range.end - range.start, 0))
      for (let n = 0; n < 1_000; n++) {
        scheduler.append([{ start: end, end: end + 1, digest }])
        end++
      }
      return 'unsettled' as const
    })
    const reread = vi.fn(async () => [{ start: 0, end: 500, digest }])
    const scheduler: NativeChatHeldHistoryVerify<TranscriptByteRange[]> =
      new NativeChatHeldHistoryVerify<TranscriptByteRange[]>({
        visible: () => true,
        olderSpan: () => ({ start: 0, end: 200 }),
        verify,
        reread,
        apply: (ranges) => ranges
      })
    try {
      scheduler.reset([{ start: 0, end, digest }])
      scheduler.replacement([{ start: 200, end, digest }], true)
      await vi.advanceTimersByTimeAsync(600_000)
      expect(Math.max(...hashed)).toBeLessThanOrEqual(700)
    } finally {
      scheduler.clear()
    }
  })

  it('keeps at most 64 proofs when overlapping appends would fragment them', async () => {
    let end = 300
    const counts: number[] = []
    const verify = vi.fn(async (ranges: TranscriptByteRange[]) => {
      counts.push(ranges.length)
      return ranges.map(() => true)
    })
    const scheduler = new NativeChatHeldHistoryVerify<TranscriptByteRange[]>({
      visible: () => true,
      olderSpan: () => ({ start: 0, end: end - 1 }),
      verify,
      reread: async () => [{ start: 0, end, digest }],
      apply: (ranges) => ranges
    })
    try {
      scheduler.reset([{ start: 0, end, digest }])
      for (let k = 0; k < 2_000; k++) {
        scheduler.append([{ start: end - 1, end: end + 1, digest }])
        end++
        if (k % 100 === 0) {
          scheduler.replacement([{ start: 100, end, digest }], true)
          await vi.advanceTimersByTimeAsync(1_000)
        }
      }
      expect(Math.max(...counts)).toBeLessThanOrEqual(64)
    } finally {
      scheduler.clear()
    }
  })

  it('retries once more for appends that land during the last timed re-read', async () => {
    let resolveRead: (() => void) | undefined
    const reread = vi.fn(
      () =>
        new Promise<TranscriptByteRange[]>((resolve) => {
          resolveRead = () => resolve([])
        })
    )
    const scheduler = new NativeChatHeldHistoryVerify<TranscriptByteRange[]>({
      visible: () => true,
      olderSpan: () => ({ start: 0, end: 300 }),
      verify: async (ranges) => ranges.map(() => false),
      reread,
      apply: () => false
    })
    try {
      scheduler.reset([{ start: 0, end: 600, digest }])
      scheduler.replacement([{ start: 300, end: 600, digest }], true)
      for (let attempt = 1; attempt <= 4; attempt++) {
        await vi.advanceTimersByTimeAsync(60_000)
        expect(reread).toHaveBeenCalledTimes(attempt)
        if (attempt === 4) {
          scheduler.append([{ start: 600, end: 601, digest }])
        }
        resolveRead?.()
      }
      await vi.advanceTimersByTimeAsync(60_000)
      expect(reread).toHaveBeenCalledTimes(5)
      resolveRead?.()
      await vi.advanceTimersByTimeAsync(600_000)
      expect(reread).toHaveBeenCalledTimes(5)
    } finally {
      scheduler.clear()
    }
  })
})
