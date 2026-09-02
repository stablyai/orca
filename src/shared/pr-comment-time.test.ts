import { describe, expect, it } from 'vitest'
import { formatPrCommentRelativeTime } from './pr-comment-time'

const NOW = Date.parse('2026-06-21T20:00:00.000Z')

describe('formatPrCommentRelativeTime', () => {
  it('formats recent and older comment timestamps compactly', () => {
    expect(formatPrCommentRelativeTime('2026-06-21T19:59:45.000Z', NOW)).toBe('just now')
    expect(formatPrCommentRelativeTime('2026-06-21T19:35:00.000Z', NOW)).toBe('25m ago')
    expect(formatPrCommentRelativeTime('2026-06-21T17:00:00.000Z', NOW)).toBe('3h ago')
    expect(formatPrCommentRelativeTime('2026-06-18T20:00:00.000Z', NOW)).toBe('3d ago')
    expect(formatPrCommentRelativeTime('2026-04-21T20:00:00.000Z', NOW)).toBe('2mo ago')
    expect(formatPrCommentRelativeTime('2024-06-21T20:00:00.000Z', NOW)).toBe('2y ago')
  })

  it('returns an empty label for invalid timestamps', () => {
    expect(formatPrCommentRelativeTime('not a date', NOW)).toBe('')
  })
})
