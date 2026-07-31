import { describe, expect, it } from 'vitest'
import {
  applyWorkspaceEmojiSuggestion,
  getActiveWorkspaceEmojiShortcode,
  replaceCompletedWorkspaceEmojiShortcode,
  searchWorkspaceEmojiShortcodes
} from './workspace-emoji-shortcodes'

describe('workspace emoji shortcodes', () => {
  it('finds standard emoji by Slack-style shortcode', () => {
    expect(searchWorkspaceEmojiShortcodes('wink', 1)).toEqual([{ emoji: '😉', shortcode: 'wink' }])
  })

  it('ranks an exact shortcode before longer aliases', () => {
    expect(searchWorkspaceEmojiShortcodes('heart', 3)[0]).toMatchObject({
      shortcode: 'heart'
    })
  })

  it('deduplicates aliases that resolve to the same emoji', () => {
    const suggestions = searchWorkspaceEmojiShortcodes('wink')
    expect(new Set(suggestions.map((suggestion) => suggestion.emoji)).size).toBe(suggestions.length)
  })

  it('detects a shortcode at the caret without matching URLs or mid-word colons', () => {
    expect(getActiveWorkspaceEmojiShortcode('Ship :win', 9)).toEqual({
      start: 5,
      end: 9,
      query: 'win'
    })
    expect(getActiveWorkspaceEmojiShortcode('https://example.com', 19)).toBeNull()
    expect(getActiveWorkspaceEmojiShortcode('fix:win', 7)).toBeNull()
  })

  it('replaces a completed shortcode and preserves text after the caret', () => {
    expect(replaceCompletedWorkspaceEmojiShortcode('Ship :wink: today', 11)).toEqual({
      value: 'Ship 😉 today',
      cursor: 7
    })
  })

  it('leaves unknown completed shortcodes unchanged', () => {
    expect(replaceCompletedWorkspaceEmojiShortcode(':orca_custom:', 13)).toBeNull()
  })

  it('applies a selected suggestion to the active shortcode range', () => {
    expect(
      applyWorkspaceEmojiSuggestion(
        'Ship :win today',
        { start: 5, end: 9, query: 'win' },
        { emoji: '😉', shortcode: 'wink' }
      )
    ).toEqual({
      value: 'Ship 😉 today',
      cursor: 7
    })
  })
})
