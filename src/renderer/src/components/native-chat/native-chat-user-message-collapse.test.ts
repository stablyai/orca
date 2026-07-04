import { describe, expect, it } from 'vitest'
import { shouldCollapseNativeChatUserMessage } from './native-chat-user-message-collapse'

describe('shouldCollapseNativeChatUserMessage', () => {
  it('does not collapse short messages', () => {
    expect(shouldCollapseNativeChatUserMessage('short message')).toBe(false)
  })

  it('collapses messages over the line threshold', () => {
    const text = Array.from({ length: 9 }, (_, i) => `${i}`).join('\n')
    expect(shouldCollapseNativeChatUserMessage(text)).toBe(true)
  })

  it('collapses messages over the character threshold', () => {
    expect(shouldCollapseNativeChatUserMessage('x'.repeat(601))).toBe(true)
  })

  it('does not collapse exactly at the thresholds', () => {
    const eightLineText = Array.from({ length: 8 }, () => 'x').join('\n')
    expect(shouldCollapseNativeChatUserMessage(eightLineText)).toBe(false)
    expect(shouldCollapseNativeChatUserMessage('x'.repeat(600))).toBe(false)
  })
})
