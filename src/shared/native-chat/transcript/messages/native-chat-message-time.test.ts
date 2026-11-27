import { describe, expect, it } from 'vitest'
import { getNativeChatMessageTimeFormatter } from './native-chat-message-time'

describe('formatCompact', () => {
  const formatter = getNativeChatMessageTimeFormatter('en-US')
  const now = new Date(2026, 10, 21, 15, 0)

  it("shows only the time for today's messages", () => {
    const time = formatter.formatCompact(new Date(2026, 10, 21, 3, 53), now)
    expect(time.replace(/\s/g, ' ')).toBe('3:53 AM')
  })

  it('shows only the day for older messages, with the year once it differs', () => {
    expect(formatter.formatCompact(new Date(2026, 10, 20, 12, 0), now)).toBe('Nov 20')
    expect(formatter.formatCompact(new Date(2025, 10, 20, 12, 0), now)).toBe('Nov 20, 2025')
  })
})
