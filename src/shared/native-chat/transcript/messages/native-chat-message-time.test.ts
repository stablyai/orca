import { describe, expect, it } from 'vitest'
import { getNativeChatMessageTimeFormatter } from './native-chat-message-time'

// Local wall-clock times, so the day boundaries hold in any time zone.
const formatter = getNativeChatMessageTimeFormatter('en-US')
const yesterday = (time: string): string => `Yesterday ${time}`
// Chromium joins date and time with ", "; newer Node ICU with " at ".
const JOIN = '(, | at )'
const at = (...parts: [number, number, number, number, number]): Date => new Date(...parts)
const label = (date: Date, now: Date): string => formatter.format(date, now, yesterday)

describe('native chat message time', () => {
  it('reads today, Yesterday, then the date, then the year, splitting days at local midnight', () => {
    const now = at(2026, 10, 17, 15, 0)
    expect(label(at(2026, 10, 17, 14, 56), now)).toBe('2:56 PM')
    expect(label(at(2026, 10, 16, 14, 56), now)).toBe('Yesterday 2:56 PM')
    expect(label(at(2026, 10, 14, 14, 56), now)).toMatch(new RegExp(`^Nov 14${JOIN}2:56 PM$`))
    expect(label(at(2025, 10, 14, 14, 56), now)).toMatch(new RegExp(`^Nov 14, 2025${JOIN}2:56 PM$`))

    const newYear = at(2026, 0, 1, 0, 5)
    expect(label(at(2026, 0, 1, 0, 0), newYear)).toBe('12:00 AM')
    expect(label(at(2025, 11, 31, 23, 59), newYear)).toBe('Yesterday 11:59 PM')
    expect(label(at(2025, 11, 30, 23, 59), newYear)).toMatch(
      new RegExp(`^Dec 30, 2025${JOIN}11:59 PM$`)
    )
  })
})
