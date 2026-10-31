import emojiShortcodes from 'emojibase-data/en/shortcodes/emojibase.json'
import {
  getStandardEmojiShortcodeEntries,
  setEmojiShortcodeDatasetLoader,
  type StandardEmojiShortcodeEntry
} from '../../../shared/emoji-shortcode-catalog'

// Keep transforms synchronous with eager catalog data; lazy loading once persisted literal :wink: during its unresolved window.
setEmojiShortcodeDatasetLoader(() => emojiShortcodes)

export type WorkspaceEmojiSuggestion = StandardEmojiShortcodeEntry

export type ActiveWorkspaceEmojiShortcode = {
  end: number
  query: string
  start: number
}

export type WorkspaceEmojiReplacement = {
  cursor: number
  value: string
}

// Build this lazy index only when a colon shortcode completes, like its shared catalog.
let exactShortcode: ReadonlyMap<string, WorkspaceEmojiSuggestion> | null = null

function exactShortcodeIndex(): ReadonlyMap<string, WorkspaceEmojiSuggestion> {
  exactShortcode ??= new Map(
    getStandardEmojiShortcodeEntries().map(({ emoji, shortcode }) => [
      shortcode,
      { emoji, shortcode }
    ])
  )
  return exactShortcode
}

// Lower tiers rank first, so `korea` surfaces `south_korea` above `dishwasher`-style incidental hits.
const MATCH_TIER = { exact: 0, prefix: 1, wordStart: 2, substring: 3 } as const

function matchTier(shortcode: string, query: string): number | null {
  const index = shortcode.indexOf(query)
  if (index === -1) {
    return null
  }
  if (index === 0) {
    return shortcode.length === query.length ? MATCH_TIER.exact : MATCH_TIER.prefix
  }
  return /[_-]/.test(shortcode[index - 1]) ? MATCH_TIER.wordStart : MATCH_TIER.substring
}

export function searchWorkspaceEmojiShortcodes(
  query: string,
  limit = 8
): WorkspaceEmojiSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery || limit <= 0) {
    return []
  }

  const matches = getStandardEmojiShortcodeEntries()
    .flatMap((entry) => {
      const tier = matchTier(entry.shortcode, normalizedQuery)
      return tier === null ? [] : [{ ...entry, tier }]
    })
    .sort(
      (left, right) =>
        left.tier - right.tier ||
        left.shortcode.length - right.shortcode.length ||
        left.shortcode.localeCompare(right.shortcode)
    )
  const seenEmoji = new Set<string>()
  const suggestions: WorkspaceEmojiSuggestion[] = []
  for (const { emoji, shortcode } of matches) {
    if (seenEmoji.has(emoji)) {
      continue
    }
    seenEmoji.add(emoji)
    suggestions.push({ emoji, shortcode })
    if (suggestions.length === limit) {
      break
    }
  }
  return suggestions
}

export function getActiveWorkspaceEmojiShortcode(
  value: string,
  cursor: number | null
): ActiveWorkspaceEmojiShortcode | null {
  if (cursor === null || cursor < 0 || cursor > value.length) {
    return null
  }
  const match = value.slice(0, cursor).match(/(^|\s):([a-z0-9_+-]{1,40})$/i)
  if (!match) {
    return null
  }
  return {
    start: cursor - match[2].length - 1,
    end: cursor,
    query: match[2].toLowerCase()
  }
}

export function replaceCompletedWorkspaceEmojiShortcode(
  value: string,
  cursor: number | null
): WorkspaceEmojiReplacement | null {
  if (cursor === null || cursor < 0 || cursor > value.length) {
    return null
  }
  const match = value.slice(0, cursor).match(/(^|\s):([a-z0-9_+-]{1,40}):$/i)
  if (!match) {
    return null
  }
  const suggestion = exactShortcodeIndex().get(match[2].toLowerCase())
  if (!suggestion) {
    return null
  }
  const start = cursor - match[2].length - 2
  return replaceWorkspaceEmojiRange(value, start, cursor, suggestion.emoji)
}

export function applyWorkspaceEmojiSuggestion(
  value: string,
  active: ActiveWorkspaceEmojiShortcode,
  suggestion: WorkspaceEmojiSuggestion
): WorkspaceEmojiReplacement {
  return replaceWorkspaceEmojiRange(value, active.start, active.end, suggestion.emoji, true)
}

function replaceWorkspaceEmojiRange(
  value: string,
  start: number,
  end: number,
  emoji: string,
  addTrailingSpace = false
): WorkspaceEmojiReplacement {
  const hasFollowingWhitespace = /\s/.test(value[end] ?? '')
  const trailingSpace = addTrailingSpace && !hasFollowingWhitespace ? ' ' : ''
  return {
    value: `${value.slice(0, start)}${emoji}${trailingSpace}${value.slice(end)}`,
    cursor: start + emoji.length + (addTrailingSpace ? 1 : 0)
  }
}

/** Insert a picked emoji at the selection, padding with spaces so it never fuses with adjacent text. */
export function insertWorkspaceEmojiAtSelection(
  value: string,
  start: number,
  end: number,
  emoji: string
): WorkspaceEmojiReplacement {
  const safeStart = Math.max(0, Math.min(start, value.length))
  const safeEnd = Math.max(safeStart, Math.min(end, value.length))
  const before = value.slice(0, safeStart)
  const after = value.slice(safeEnd)
  const leadingSpace = before && !/\s$/.test(before) ? ' ' : ''
  const trailingSpace = after && /^\s/.test(after) ? '' : ' '
  const inserted = `${leadingSpace}${emoji}${trailingSpace}`
  return {
    value: `${before}${inserted}${after}`,
    cursor: before.length + inserted.length
  }
}

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
