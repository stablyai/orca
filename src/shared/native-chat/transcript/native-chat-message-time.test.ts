import { describe, expect, it } from 'vitest'
import { getNativeChatMessageTimeFormatter } from './native-chat-message-time'

describe('native chat message time', () => {
  it('includes the local date outside today and the year outside this year', () => {
    const formatter = getNativeChatMessageTimeFormatter('en-US')
    const now = new Date(2026, 10, 8, 0, 15)

    expect(formatter.format(new Date(2026, 10, 8, 0, 5), now)).toBe('12:05 AM')
    expect(formatter.format(new Date(2026, 10, 7, 23, 42), now)).toMatch(/^Nov 7\b/)
    expect(formatter.format(new Date(2025, 10, 7, 23, 42), now)).toMatch(/^Nov 7, 2025\b/)
  })
})
