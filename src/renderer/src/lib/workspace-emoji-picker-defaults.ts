import type { WorkspaceEmojiSuggestion } from './workspace-emoji-shortcodes'

// Lives apart from the shortcode index so only the lazily loaded picker panel ships it.
// Shown before the user searches: emoji that read well as workspace markers.
// Only emoji-presentation code points: text-default ones (gear, warning, sun) render as monochrome glyphs.
// Literal pairs so opening the picker never builds the full shortcode catalog; a test keeps them in sync.
const WORKSPACE_EMOJI_PICKER_DEFAULTS: readonly WorkspaceEmojiSuggestion[] = [
  { emoji: '🚀', shortcode: 'rocket' },
  { emoji: '🐛', shortcode: 'bug' },
  { emoji: '✨', shortcode: 'sparkles' },
  { emoji: '🔥', shortcode: 'fire' },
  { emoji: '⚡', shortcode: 'zap' },
  { emoji: '🧪', shortcode: 'test_tube' },
  { emoji: '📦', shortcode: 'package' },
  { emoji: '🔧', shortcode: 'wrench' },
  { emoji: '🔨', shortcode: 'hammer' },
  { emoji: '🔩', shortcode: 'nut_and_bolt' },
  { emoji: '🚧', shortcode: 'construction' },
  { emoji: '🚨', shortcode: 'rotating_light' },
  { emoji: '🔒', shortcode: 'lock' },
  { emoji: '🔑', shortcode: 'key' },
  { emoji: '🛡', shortcode: 'shield' },
  { emoji: '🧹', shortcode: 'broom' },
  { emoji: '📝', shortcode: 'memo' },
  { emoji: '📚', shortcode: 'books' },
  { emoji: '🔖', shortcode: 'bookmark' },
  { emoji: '📌', shortcode: 'pushpin' },
  { emoji: '📎', shortcode: 'paperclip' },
  { emoji: '🔗', shortcode: 'link' },
  { emoji: '📋', shortcode: 'clipboard' },
  { emoji: '📆', shortcode: 'calendar' },
  { emoji: '💡', shortcode: 'bulb' },
  { emoji: '🔍', shortcode: 'mag' },
  { emoji: '👀', shortcode: 'eyes' },
  { emoji: '💬', shortcode: 'speech_balloon' },
  { emoji: '🔔', shortcode: 'bell' },
  { emoji: '🛟', shortcode: 'lifebuoy' },
  { emoji: '🤖', shortcode: 'robot' },
  { emoji: '🔬', shortcode: 'microscope' },
  { emoji: '✅', shortcode: 'white_check_mark' },
  { emoji: '⛔', shortcode: 'no_entry' },
  { emoji: '⌛', shortcode: 'hourglass' },
  { emoji: '🏆', shortcode: 'trophy' },
  { emoji: '⭐', shortcode: 'star' },
  { emoji: '🎉', shortcode: 'tada' },
  { emoji: '🎯', shortcode: 'dart' },
  { emoji: '🧩', shortcode: 'puzzle_piece' },
  { emoji: '🌱', shortcode: 'seedling' },
  { emoji: '🌸', shortcode: 'cherry_blossom' },
  { emoji: '🌈', shortcode: 'rainbow' },
  { emoji: '🌻', shortcode: 'sunflower' },
  { emoji: '🌙', shortcode: 'crescent_moon' },
  { emoji: '💜', shortcode: 'purple_heart' },
  { emoji: '☕', shortcode: 'coffee' },
  { emoji: '👻', shortcode: 'ghost' }
]

export function getWorkspaceEmojiPickerDefaults(): readonly WorkspaceEmojiSuggestion[] {
  return WORKSPACE_EMOJI_PICKER_DEFAULTS
}
