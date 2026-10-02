import { describe, expect, it } from 'vitest'
import {
  isNativeChatReasoningUnderway,
  nativeChatReasoningHeadline,
  nativeChatReasoningHeadlineText
} from './native-chat-reasoning-row'

describe('the reasoning row every client draws', () => {
  it('is hidden only while its block is still being written in a running turn', () => {
    expect(isNativeChatReasoningUnderway({ role: 'reasoning', state: 'running' }, true)).toBe(true)
    expect(isNativeChatReasoningUnderway({ role: 'reasoning', state: 'running' }, false)).toBe(
      false
    )
    expect(isNativeChatReasoningUnderway({ role: 'reasoning', state: 'completed' }, true)).toBe(
      false
    )
    expect(isNativeChatReasoningUnderway({ role: 'reasoning' }, true)).toBe(false)
    expect(isNativeChatReasoningUnderway({ role: 'assistant', state: 'running' }, true)).toBe(false)
  })

  it('reads the span the host saw, at least a second, and claims none it did not see', () => {
    const text = (fields: { state?: 'running' | 'completed'; completedAt?: number }) =>
      nativeChatReasoningHeadlineText(nativeChatReasoningHeadline({ timestamp: 1_000, ...fields }))
    expect(text({ state: 'completed', completedAt: 66_000 })).toBe('Thought for 1m 5s')
    expect(text({ state: 'completed', completedAt: 1_300 })).toBe('Thought for 1s')
    expect(text({ state: 'completed' })).toBe('Thought')
    expect(text({ state: 'running' })).toBe('Thought')
    expect(text({})).toBe('Reasoning')
  })
})
