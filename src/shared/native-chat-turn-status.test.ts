import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import {
  describeNativeChatTurnStatus,
  formatNativeChatDuration,
  formatNativeChatTurnStatusLabel,
  nativeChatElapsedSeconds,
  nativeChatTurnHasResponse,
  reduceNativeChatTurnTiming,
  selectNativeChatTurnStatuses,
  type NativeChatTurnTimingByTurn
} from './native-chat-turn-status'

function message(
  id: string,
  role: NativeChatMessage['role'],
  blocks: NativeChatMessage['blocks']
): NativeChatMessage {
  return { id, role, blocks, timestamp: null, source: 'transcript' }
}

describe('formatNativeChatDuration', () => {
  it.each([
    [0, '0s'],
    [12, '12s'],
    [59, '59s'],
    [60, '1m 0s'],
    [184, '3m 4s'],
    [3600, '1h 0m 0s'],
    [3723, '1h 2m 3s']
  ])('formats %i seconds as %s', (seconds, expected) => {
    expect(formatNativeChatDuration(seconds)).toBe(expected)
  })

  it('floors a fractional count and clamps a negative or non-finite one', () => {
    expect(formatNativeChatDuration(12.9)).toBe('12s')
    expect(formatNativeChatDuration(-5)).toBe('0s')
    expect(formatNativeChatDuration(Number.NaN)).toBe('0s')
  })
})

describe('describeNativeChatTurnStatus', () => {
  it('prefers the settled duration over the thinking and counting labels', () => {
    expect(
      describeNativeChatTurnStatus({ thinking: true, workedSeconds: 184, elapsedSeconds: 9 })
    ).toEqual({ key: 'workedFor', duration: '3m 4s' })
  })

  it('reports thinking before the turn produces output', () => {
    expect(
      describeNativeChatTurnStatus({ thinking: true, workedSeconds: null, elapsedSeconds: 9 })
    ).toEqual({ key: 'thinking', duration: null })
  })

  it('counts once the turn has output', () => {
    expect(
      describeNativeChatTurnStatus({ thinking: false, workedSeconds: null, elapsedSeconds: 12 })
    ).toEqual({ key: 'workingFor', duration: '12s' })
  })
})

describe('formatNativeChatTurnStatusLabel', () => {
  it('renders each state in English for platforms without i18n', () => {
    expect(
      formatNativeChatTurnStatusLabel({ thinking: true, workedSeconds: null, elapsedSeconds: 0 })
    ).toBe('Thinking')
    expect(
      formatNativeChatTurnStatusLabel({ thinking: false, workedSeconds: null, elapsedSeconds: 12 })
    ).toBe('Working for 12s')
    expect(
      formatNativeChatTurnStatusLabel({ thinking: false, workedSeconds: 184, elapsedSeconds: 0 })
    ).toBe('Worked for 3m 4s')
  })
})

describe('nativeChatTurnHasResponse', () => {
  const user = message('u1', 'user', [{ type: 'text', text: 'go' }])

  it('is false while the turn has produced nothing', () => {
    expect(nativeChatTurnHasResponse([user], 0)).toBe(false)
  })

  it('ignores a whitespace-only assistant block', () => {
    const blank = message('a1', 'assistant', [{ type: 'text', text: '   \n ' }])
    expect(nativeChatTurnHasResponse([user, blank], 0)).toBe(false)
  })

  it('is true on the first real text, tool call, or tool result', () => {
    expect(
      nativeChatTurnHasResponse(
        [user, message('a1', 'assistant', [{ type: 'text', text: 'hi' }])],
        0
      )
    ).toBe(true)
    expect(
      nativeChatTurnHasResponse(
        [user, message('t1', 'tool', [{ type: 'tool-call', name: 'Read', input: {} }])],
        0
      )
    ).toBe(true)
    expect(
      nativeChatTurnHasResponse(
        [user, message('t1', 'tool', [{ type: 'tool-result', output: 'ok' }])],
        0
      )
    ).toBe(true)
  })

  it('does not count output that preceded the latest user turn', () => {
    const earlier = message('a0', 'assistant', [{ type: 'text', text: 'old' }])
    expect(nativeChatTurnHasResponse([earlier, user], 1)).toBe(false)
  })
})

describe('reduceNativeChatTurnTiming', () => {
  const validTurnKeys = new Set(['u1'])

  it('stamps a start when a turn begins working', () => {
    const next = reduceNativeChatTurnTiming(
      {},
      { activeTurnKey: 'u1', validTurnKeys, isWorking: true, now: 1_000 }
    )
    expect(next).toEqual({ u1: { startedAt: 1_000, workedSeconds: null } })
  })

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

  it('prefers an authoritative host start over the local stamp', () => {
    const next = reduceNativeChatTurnTiming(
      {},
      {
        activeTurnKey: 'u1',
        validTurnKeys,
        isWorking: true,
        workingStartedAt: 500,
        now: 1_000
      }
    )
    expect(next.u1?.startedAt).toBe(500)
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
    // The mobile composer renders an accepted send as `pending-N` until the
    // transcript echo lands under its real id. Without the carry-over the active
    // turn key flips mid-turn and "Working for 8s" restarts at 0s.
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
    // The swap can land after the turn settles. Re-keying (rather than only
    // carrying a start) is what keeps the "Worked for N" row from vanishing.
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
  it('reports the working turn as thinking until it produces output', () => {
    const { active } = selectNativeChatTurnStatuses(
      { u1: { startedAt: 1_000, workedSeconds: null } },
      { activeTurnKey: 'u1', isWorking: true, hasCurrentTurnResponse: false }
    )
    expect(active).toEqual({ startedAt: 1_000, thinking: true, workedSeconds: null })
  })

  it('stops thinking once the turn has output', () => {
    const { active } = selectNativeChatTurnStatuses(
      { u1: { startedAt: 1_000, workedSeconds: null } },
      { activeTurnKey: 'u1', isWorking: true, hasCurrentTurnResponse: true }
    )
    expect(active?.thinking).toBe(false)
  })

  it('exposes settled turns and resolves the active one from them when idle', () => {
    const { active, completedByTurn } = selectNativeChatTurnStatuses(
      { u1: { startedAt: 1_000, workedSeconds: 12 } },
      { activeTurnKey: 'u1', isWorking: false, hasCurrentTurnResponse: true }
    )
    expect(completedByTurn.u1).toEqual({ startedAt: 1_000, thinking: false, workedSeconds: 12 })
    expect(active).toEqual(completedByTurn.u1)
  })

  it('omits an in-flight turn from the completed map', () => {
    const { completedByTurn } = selectNativeChatTurnStatuses(
      { u1: { startedAt: 1_000, workedSeconds: null } },
      { activeTurnKey: 'u1', isWorking: true, hasCurrentTurnResponse: true }
    )
    expect(completedByTurn).toEqual({})
  })
})

describe('nativeChatElapsedSeconds', () => {
  it('falls back to the mount epoch before the turn start lands', () => {
    expect(nativeChatElapsedSeconds(null, 1_000, 5_400)).toBe(4)
    expect(nativeChatElapsedSeconds(2_000, 1_000, 5_400)).toBe(3)
  })

  it('never counts backwards', () => {
    expect(nativeChatElapsedSeconds(9_000, 1_000, 5_000)).toBe(0)
  })
})
