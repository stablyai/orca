import { describe, expect, it } from 'vitest'
import {
  describeNativeChatActiveTurnLabel,
  formatNativeChatTurnRate,
  reduceNativeChatTurnTiming,
  selectNativeChatTurnStatuses,
  type NativeChatTurnTimingByTurn
} from './native-chat-turn-status'

describe('describeNativeChatActiveTurnLabel', () => {
  it("says Stopping over the provider's activity once a person's Stop is ending the turn", () => {
    expect(
      describeNativeChatActiveTurnLabel({
        activityText: 'Running pnpm test',
        thinking: true,
        stopping: true
      })
    ).toEqual({ source: 'status', key: 'stopping' })
  })
})

describe('reduceNativeChatTurnTiming', () => {
  const validTurnKeys = new Set(['u1'])

  it('keeps the original start across later working ticks', () => {
    const first = reduceNativeChatTurnTiming(
      {},
      { activeTurnKey: 'u1', validTurnKeys, isWorking: true, now: 1_000 }
    )
    const second = reduceNativeChatTurnTiming(first, {
      activeTurnKey: 'u1',
      validTurnKeys,
      isWorking: true,
      now: 9_000
    })
    expect(second).toBe(first)
  })

  it('settles the turn to whole elapsed seconds when work stops', () => {
    const working = reduceNativeChatTurnTiming(
      {},
      { activeTurnKey: 'u1', validTurnKeys, isWorking: true, now: 1_000 }
    )
    const settled = reduceNativeChatTurnTiming(working, {
      activeTurnKey: 'u1',
      validTurnKeys,
      isWorking: false,
      now: 13_400
    })
    expect(settled.u1).toEqual({ startedAt: 1_000, workedSeconds: 12 })
  })

  it('never re-settles an already settled turn', () => {
    const settled: NativeChatTurnTimingByTurn = { u1: { startedAt: 1_000, workedSeconds: 12 } }
    expect(
      reduceNativeChatTurnTiming(settled, {
        activeTurnKey: 'u1',
        validTurnKeys,
        isWorking: false,
        now: 99_000
      })
    ).toBe(settled)
  })

  it('does not invent a settled turn that never started', () => {
    expect(
      reduceNativeChatTurnTiming(
        {},
        { activeTurnKey: 'u1', validTurnKeys, isWorking: false, now: 1_000 }
      )
    ).toEqual({})
  })

  it('carries the elapsed start across an optimistic echo becoming a transcript row', () => {
    // Mobile pending-N ids become transcript ids mid-turn; carry timing so the running clock cannot restart.
    const working = reduceNativeChatTurnTiming(
      {},
      {
        activeTurnKey: 'pending-1',
        validTurnKeys: new Set<string>(),
        isWorking: true,
        now: 1_000
      }
    )
    expect(working['pending-1']?.startedAt).toBe(1_000)
    const swapped = reduceNativeChatTurnTiming(working, {
      activeTurnKey: 'u9',
      previousActiveTurnKey: 'pending-1',
      validTurnKeys: new Set(['u9']),
      isWorking: true,
      now: 9_000
    })
    expect(swapped.u9).toEqual({ startedAt: 1_000, workedSeconds: null })
    expect(swapped['pending-1']).toBeUndefined()
  })

  it('keeps a settled turn visible when the echo is replaced after it finished', () => {
    // Re-key settled timing too or late echo replacement removes the Worked for row.
    const settled: NativeChatTurnTimingByTurn = {
      'pending-1': { startedAt: 1_000, workedSeconds: 12 }
    }
    const swapped = reduceNativeChatTurnTiming(settled, {
      activeTurnKey: 'u9',
      previousActiveTurnKey: 'pending-1',
      validTurnKeys: new Set(['u9']),
      isWorking: false,
      now: 20_000
    })
    expect(swapped.u9).toEqual({ startedAt: 1_000, workedSeconds: 12 })
    expect(swapped['pending-1']).toBeUndefined()
  })

  it('settles a re-keyed in-flight turn from its original start', () => {
    const working = reduceNativeChatTurnTiming(
      {},
      { activeTurnKey: 'pending-1', validTurnKeys: new Set<string>(), isWorking: true, now: 1_000 }
    )
    const settled = reduceNativeChatTurnTiming(working, {
      activeTurnKey: 'u9',
      previousActiveTurnKey: 'pending-1',
      validTurnKeys: new Set(['u9']),
      isWorking: false,
      now: 13_400
    })
    expect(settled.u9).toEqual({ startedAt: 1_000, workedSeconds: 12 })
  })

  it('does not carry the start into a genuinely new turn', () => {
    // The previous turn is still in the transcript, so this is the user sending
    // again — that turn starts its own clock.
    const working = reduceNativeChatTurnTiming(
      {},
      { activeTurnKey: 'u1', validTurnKeys: new Set(['u1']), isWorking: true, now: 1_000 }
    )
    const next = reduceNativeChatTurnTiming(working, {
      activeTurnKey: 'u2',
      previousActiveTurnKey: 'u1',
      validTurnKeys: new Set(['u1', 'u2']),
      isWorking: true,
      now: 9_000
    })
    expect(next.u2?.startedAt).toBe(9_000)
  })

  it('does not carry a start from a turn that had already settled', () => {
    const settled: NativeChatTurnTimingByTurn = {
      'pending-1': { startedAt: 1_000, workedSeconds: 5 }
    }
    const next = reduceNativeChatTurnTiming(settled, {
      activeTurnKey: 'u9',
      previousActiveTurnKey: 'pending-1',
      validTurnKeys: new Set(['u9']),
      isWorking: true,
      now: 9_000
    })
    expect(next.u9?.startedAt).toBe(9_000)
  })

  it('drops timings for turns that left the transcript, keeping the active one', () => {
    const current: NativeChatTurnTimingByTurn = {
      gone: { startedAt: 1, workedSeconds: 2 },
      u1: { startedAt: 1_000, workedSeconds: 12 }
    }
    const next = reduceNativeChatTurnTiming(current, {
      activeTurnKey: 'u1',
      validTurnKeys,
      isWorking: false,
      now: 2_000
    })
    expect(Object.keys(next)).toEqual(['u1'])
  })
})

describe('selectNativeChatTurnStatuses', () => {
  it('keeps the selected live start monotonic until the exact request origin arrives', () => {
    const optimistic = reduceNativeChatTurnTiming(
      {},
      { activeTurnKey: 'u1', validTurnKeys: new Set(['u1']), isWorking: true, now: 1_000 }
    )
    const turnStarted = reduceNativeChatTurnTiming(optimistic, {
      activeTurnKey: 'u1',
      validTurnKeys: new Set(['u1']),
      isWorking: true,
      workingStartedAt: 8_000,
      now: 8_000
    })
    const beforeEcho = selectNativeChatTurnStatuses(turnStarted, {
      activeTurnKey: 'u1',
      isWorking: true,
      workingStartedAt: 8_000,
      thinking: false
    })
    const exactOrigin = reduceNativeChatTurnTiming(turnStarted, {
      activeTurnKey: 'u1',
      validTurnKeys: new Set(['u1']),
      isWorking: true,
      workingStartedAt: 900,
      now: 8_100
    })
    const afterEcho = selectNativeChatTurnStatuses(exactOrigin, {
      activeTurnKey: 'u1',
      isWorking: true,
      workingStartedAt: 900,
      thinking: false
    })

    expect(beforeEcho.active?.startedAt).toBe(1_000)
    expect(afterEcho.active?.startedAt).toBe(900)
  })

  it('omits an in-flight turn from the completed map', () => {
    const { completedByTurn } = selectNativeChatTurnStatuses(
      { u1: { startedAt: 1_000, workedSeconds: null } },
      { activeTurnKey: 'u1', isWorking: true, thinking: false }
    )
    expect(completedByTurn).toEqual({})
  })

  it('keeps the just-ended turn live until its local duration is stamped', () => {
    const running = { u1: { startedAt: 1_000, workedSeconds: null } }
    const { active } = selectNativeChatTurnStatuses(running, {
      activeTurnKey: 'u1',
      isWorking: false,
      thinking: true
    })
    expect(active).toEqual({ startedAt: 1_000, thinking: false, workedSeconds: null })
    // The host saying it never saw the end still wins.
    const unverifiable = selectNativeChatTurnStatuses(running, {
      activeTurnKey: 'u1',
      isWorking: false,
      thinking: false,
      settledByTurn: new Map([['u1', null]])
    })
    expect(unverifiable.active).toBeNull()
  })

  it('surfaces positive settled throughput on active and prior turns without claiming a live rate', () => {
    const settledByTurn = new Map([
      ['u1', { startedAt: 1_000, workedSeconds: 0, tokensPerSecond: 42 }],
      ['u2', { startedAt: 2_000, workedSeconds: 3, tokensPerSecond: 0 }]
    ])
    const running = selectNativeChatTurnStatuses(
      { u1: { startedAt: 1_000, workedSeconds: null } },
      { activeTurnKey: 'u1', isWorking: true, thinking: false, settledByTurn }
    )
    expect(running.active?.tokensPerSecond).toBeUndefined()
    expect(formatNativeChatTurnRate(running.active?.workedSeconds, 42)).toBe('')

    const settled = selectNativeChatTurnStatuses(
      {},
      { activeTurnKey: 'u1', isWorking: false, thinking: false, settledByTurn }
    )
    expect(settled.active?.tokensPerSecond).toBe(42)
    expect(
      formatNativeChatTurnRate(settled.active?.workedSeconds, settled.active?.tokensPerSecond)
    ).toBe(' · 42.0 tok/s')
    expect(settled.completedByTurn.u2?.tokensPerSecond).toBeUndefined()
    expect(formatNativeChatTurnRate(3, settled.completedByTurn.u2?.tokensPerSecond)).toBe('')
  })
})
