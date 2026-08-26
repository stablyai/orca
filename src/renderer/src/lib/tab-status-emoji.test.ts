import { describe, expect, it } from 'vitest'
import { getTabStatusEmoji, prefixTabTitleWithStatusEmoji } from './tab-status-emoji'

describe('getTabStatusEmoji', () => {
  it.each([
    ['working', '⚙'],
    ['permission', '✋'],
    ['done', '✅']
  ] as const)('marks %s', (status, emoji) => {
    expect(getTabStatusEmoji(status)).toBe(emoji)
  })

  it.each(['active', 'inactive'] as const)('leaves %s unmarked', (status) => {
    expect(getTabStatusEmoji(status)).toBeNull()
  })

  it('tolerates a missing status', () => {
    expect(getTabStatusEmoji(null)).toBeNull()
    expect(getTabStatusEmoji(undefined)).toBeNull()
  })
})

describe('prefixTabTitleWithStatusEmoji', () => {
  it('prefixes only when the setting is on', () => {
    expect(prefixTabTitleWithStatusEmoji('Build', 'working', true)).toBe('⚙ Build')
    expect(prefixTabTitleWithStatusEmoji('Build', 'working', false)).toBe('Build')
  })

  it('leaves a title alone when the status carries no marker', () => {
    expect(prefixTabTitleWithStatusEmoji('Build', 'inactive', true)).toBe('Build')
  })

  it('never returns a lone glyph for an empty title', () => {
    expect(prefixTabTitleWithStatusEmoji('', 'working', true)).toBe('')
    expect(prefixTabTitleWithStatusEmoji('   ', 'done', true)).toBe('   ')
  })

  // Why: the status resolver reruns on every store write, so a naive prefix
  // would stack glyphs into "⚙ ⚙ ⚙ Build".
  it('does not stack the marker when reapplied', () => {
    const once = prefixTabTitleWithStatusEmoji('Build', 'working', true)
    expect(prefixTabTitleWithStatusEmoji(once, 'working', true)).toBe('⚙ Build')
  })

  it('replaces the previous marker when the status changes', () => {
    const working = prefixTabTitleWithStatusEmoji('Build', 'working', true)
    expect(prefixTabTitleWithStatusEmoji(working, 'done', true)).toBe('✅ Build')
  })
})
