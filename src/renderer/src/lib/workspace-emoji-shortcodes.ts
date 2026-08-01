import {
  STANDARD_EMOJI_SHORTCODE_ENTRIES,
  type StandardEmojiShortcodeEntry
} from '../../../shared/emoji-shortcode-catalog'

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

const WORKSPACE_EMOJI_SHORTCODE_ADDITIONS: readonly WorkspaceEmojiSuggestion[] = [
  { emoji: '🇰🇷', shortcode: 'flag_kr' }
]

const SHORTCODE_ENTRIES = [
  ...STANDARD_EMOJI_SHORTCODE_ENTRIES,
  ...WORKSPACE_EMOJI_SHORTCODE_ADDITIONS
]

const EXACT_SHORTCODE = new Map(
  SHORTCODE_ENTRIES.map(({ emoji, shortcode }) => [shortcode, { emoji, shortcode }])
)

export function searchWorkspaceEmojiShortcodes(
  query: string,
  limit = 8
): WorkspaceEmojiSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery || limit <= 0) {
    return []
  }

  const matches = SHORTCODE_ENTRIES.filter(({ shortcode }) =>
    shortcode.startsWith(normalizedQuery)
  ).sort(
    (left, right) =>
      Number(right.shortcode === normalizedQuery) - Number(left.shortcode === normalizedQuery) ||
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
  const suggestion = EXACT_SHORTCODE.get(match[2].toLowerCase())
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
  return replaceWorkspaceEmojiRange(value, active.start, active.end, suggestion.emoji)
}

function replaceWorkspaceEmojiRange(
  value: string,
  start: number,
  end: number,
  emoji: string
): WorkspaceEmojiReplacement {
  return {
    value: `${value.slice(0, start)}${emoji}${value.slice(end)}`,
    cursor: start + emoji.length
  }
}
