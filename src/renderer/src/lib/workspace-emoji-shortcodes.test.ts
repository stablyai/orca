import { describe, expect, it } from 'vitest'
import {
  applyWorkspaceEmojiSuggestion,
  getActiveWorkspaceEmojiShortcode,
  replaceCompletedWorkspaceEmojiShortcode
} from './workspace-emoji-shortcodes'

describe('workspace emoji shortcodes', () => {
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

  it('replaces a completed flag shortcode', () => {
    expect(replaceCompletedWorkspaceEmojiShortcode(':flag_kr:', 9)).toEqual({
      value: '🇰🇷',
      cursor: 4
    })
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
      cursor: 8
    })
  })
})
