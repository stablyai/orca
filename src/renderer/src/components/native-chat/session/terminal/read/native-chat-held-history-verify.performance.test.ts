import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { withHeldOlderHistory } from '../../../viewport/history/native-chat-pagination'
import { NativeChatHeldHistoryVerify } from './native-chat-held-history-verify'

// PR #45168: retained history must not multiply filesystem work during replacement bursts.
describe.each([10_000, 100_000])('held-history verification at %i rows', (count) => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function history(
    verify: (
      ranges: { start: number; end: number; digest: string }[],
      signal: AbortSignal
    ) => Promise<boolean[]>
  ) {
    const readSession = vi.fn().mockResolvedValue(undefined)
    const scheduler = new NativeChatHeldHistoryVerify({
      visible: () => true,
      verify,
      reread: readSession,
      apply: () => undefined
    })
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
    scheduler.reset(window)
    scheduler.prepend([{ start: 0, end: count - 300, digest: '0000000000000200' }])
    const replace = (): void => {
      const base = withHeldOlderHistory(
        'claude',
        { phase: 'ready', messages: held },
        [],
        windowRows,
        true
      )
      scheduler.replacement(window, base !== windowRows)
    }
    return { scheduler, replace, readSession }
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
