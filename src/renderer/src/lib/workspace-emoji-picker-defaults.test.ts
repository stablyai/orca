import { describe, expect, it } from 'vitest'
import { getWorkspaceEmojiPickerDefaults } from './workspace-emoji-picker-defaults'
import { searchWorkspaceEmojiShortcodes } from './workspace-emoji-shortcodes'

describe('getWorkspaceEmojiPickerDefaults', () => {
  it('matches the shortcode catalog exactly and lists distinct emoji', () => {
    const defaults = getWorkspaceEmojiPickerDefaults()
    expect(defaults).toHaveLength(48)
    expect(new Set(defaults.map((entry) => entry.emoji)).size).toBe(48)
    for (const entry of defaults) {
      expect(searchWorkspaceEmojiShortcodes(entry.shortcode, 1)[0]).toEqual(entry)
    }
  })
})
