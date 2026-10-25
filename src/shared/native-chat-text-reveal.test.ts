import { describe, expect, it } from 'vitest'
import {
  advanceNativeChatText,
  arriveNativeChatText,
  NATIVE_CHAT_TEXT_REVEAL_DELAY_MS,
  pacedTextEnd,
  type NativeChatTextReveal
} from './native-chat-text-reveal'

describe('pacedTextEnd', () => {
  it('finishes words and holds only the unfinished tail', () => {
    expect(pacedTextEnd('hello brave world', 7, true)).toBe('hello brave'.length)
    expect(pacedTextEnd('hello bra', 7, true)).toBe('hello '.length)
    expect(pacedTextEnd('hello bra', 7, false)).toBe('hello bra'.length)
    expect(pacedTextEnd('こんにちは世界', 3, true)).toBe(3)
  })
  it('never stops inside an emoji', () => {
    const text = 'ok 👍👍 done'
    for (let position = 0; position <= text.length; position += 1) {
      expect(text.slice(0, pacedTextEnd(text, position, false)).isWellFormed()).toBe(true)
    }
  })
})

describe('arrival deadlines', () => {
  it('does not let later bursts postpone an earlier deadline', () => {
    let state: NativeChatTextReveal = { source: '', shown: 0, arrivals: [] }
    state = arriveNativeChatText(state, 'x'.repeat(2000), 0)
    state = arriveNativeChatText(state, 'x'.repeat(5000), 340)
    state = advanceNativeChatText(state, NATIVE_CHAT_TEXT_REVEAL_DELAY_MS)
    expect(state.shown).toBeGreaterThanOrEqual(2000)
    expect(advanceNativeChatText(state, 340 + NATIVE_CHAT_TEXT_REVEAL_DELAY_MS).shown).toBe(5000)
  })
  it('overlaps chunk contributions without jumping over the unrevealed prefix', () => {
    let state: NativeChatTextReveal = { source: '', shown: 0, arrivals: [] }
    state = arriveNativeChatText(state, 'a '.repeat(50), 0)
    state = advanceNativeChatText(state, 100)
    const before = state.shown
    state = arriveNativeChatText(state, 'a '.repeat(100), 100)
    state = advanceNativeChatText(state, 101)
    expect(state.shown - before).toBeLessThanOrEqual(2)
    expect(state.shown).toBeLessThan(100)
  })

  it('catches up after a hidden window without clamping elapsed time', () => {
    const state = arriveNativeChatText(
      { source: '', shown: 0, arrivals: [] },
      'x'.repeat(100_000),
      0
    )
    expect(advanceNativeChatText(state, 10_000).shown).toBe(100_000)
  })
})
