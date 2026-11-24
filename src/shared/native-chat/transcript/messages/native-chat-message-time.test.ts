import { describe, expect, it } from 'vitest'
import { getNativeChatMessageTimeFormatter } from './native-chat-message-time'

describe('formatCompact', () => {
  const formatter = getNativeChatMessageTimeFormatter('en-US', { timeZone: 'UTC' })
  const now = new Date(2026, 10, 21, 15, 0)

  it("shows only the time for today's messages", () => {
    expect(formatter.formatCompact(new Date(2026, 10, 21, 3, 53), now)).toMatch(
      /^\d{1,2}:53\s?[AP]M$/
    )
  })

  it('shows only the day for older messages, with the year once it differs', () => {
    expect(formatter.formatCompact(new Date(2026, 10, 20, 12, 0), now)).toMatch(/^Nov \d{1,2}$/)
    expect(formatter.formatCompact(new Date(2025, 10, 20, 12, 0), now)).toMatch(
      /^Nov \d{1,2}, 2025$/
    )
  })
})
