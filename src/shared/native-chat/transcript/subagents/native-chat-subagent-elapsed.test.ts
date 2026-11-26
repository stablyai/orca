import { describe, expect, it } from 'vitest'
import {
  nativeChatSubagentGroupHeader,
  sayNativeChatSubagentGroupEnglish,
  subagentGroupElapsedTiming
} from './native-chat-subagent-group-header'
import { subagentElapsedTiming } from './native-chat-subagent-summary'

describe('subagentElapsedTiming', () => {
  it('uses host startedAt when working', () => {
    expect(subagentElapsedTiming({ state: 'working', startedAt: 1_000 }, 5_000)).toEqual({
      startedAt: 1_000,
      settledAt: null,
      counting: true
    })
  })

  it('falls back to mount timestamp while working without host startedAt', () => {
    expect(subagentElapsedTiming({ state: 'working' }, 5_000)).toEqual({
      startedAt: 5_000,
      settledAt: null,
      counting: true
    })
  })

  it('prefers host startedAt over fallback when both are finite', () => {
    expect(subagentElapsedTiming({ state: 'working', startedAt: 2_500 }, 5_000)).toEqual({
      startedAt: 2_500,
      settledAt: null,
      counting: true
    })
  })

  it('ignores non-finite startedAt and fallback', () => {
    expect(subagentElapsedTiming({ state: 'working', startedAt: Number.NaN }, 5_000)).toEqual({
      startedAt: 5_000,
      settledAt: null,
      counting: true
    })
    expect(subagentElapsedTiming({ state: 'working' }, null)).toBeNull()
  })

  it('returns settled timing only when both startedAt and settledAt are known', () => {
    expect(
      subagentElapsedTiming({ state: 'completed', startedAt: 1_000, settledAt: 8_000 }, 12_000)
    ).toEqual({
      startedAt: 1_000,
      settledAt: 8_000,
      counting: false
    })
    expect(
      subagentElapsedTiming({ state: 'completed', startedAt: 9_000, settledAt: 8_000 })
    ).toEqual({
      startedAt: 9_000,
      settledAt: 9_000,
      counting: false
    })
    expect(subagentElapsedTiming({ state: 'completed', startedAt: 1_000 }, 12_000)).toBeNull()
    expect(subagentElapsedTiming({ state: 'failed', settledAt: 8_000 }, 12_000)).toBeNull()
  })
})

describe('subagentGroupElapsedTiming', () => {
  it('uses summary clockStartedAt when available', () => {
    const header = nativeChatSubagentGroupHeader(
      [
        { id: 'a1', label: 'Explore A', state: 'working', startedAt: 2_000 },
        { id: 'a2', label: 'Explore B', state: 'completed', startedAt: 1_000, settledAt: 3_000 }
      ],
      sayNativeChatSubagentGroupEnglish
    )
    expect(subagentGroupElapsedTiming(header, 9_000)).toEqual({
      startedAt: 1_000,
      settledAt: null,
      counting: true
    })
  })

  it('falls back to mount timestamp when a working group lacks child startedAt', () => {
    const header = nativeChatSubagentGroupHeader(
      [
        { id: 'a1', label: 'Explore A', state: 'working' },
        { id: 'a2', label: 'Explore B', state: 'working' }
      ],
      sayNativeChatSubagentGroupEnglish
    )
    expect(header.clockStartedAt).toBeNull()
    expect(subagentGroupElapsedTiming(header, 9_000)).toEqual({
      startedAt: 9_000,
      settledAt: null,
      counting: true
    })
  })

  it('returns null when settled group duration is unknown', () => {
    const header = nativeChatSubagentGroupHeader(
      [
        { id: 'a1', label: 'Explore A', state: 'completed', startedAt: 1_000 },
        { id: 'a2', label: 'Explore B', state: 'completed', startedAt: 1_500, settledAt: 4_000 }
      ],
      sayNativeChatSubagentGroupEnglish
    )
    expect(subagentGroupElapsedTiming(header, 9_000)).toBeNull()
  })
})
