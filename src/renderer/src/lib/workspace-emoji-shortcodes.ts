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

const EXACT_SHORTCODE = new Map(
  STANDARD_EMOJI_SHORTCODE_ENTRIES.map(({ emoji, shortcode }) => [shortcode, { emoji, shortcode }])
)

// Lower tiers rank first, so `korea` surfaces `south_korea` above `dishwasher`-style incidental hits.
const MATCH_TIER = { exact: 0, prefix: 1, wordStart: 2, substring: 3 } as const

function matchTier(shortcode: string, query: string): number | null {
  const index = shortcode.indexOf(query)
  if (index < 0) {
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

  const matches = STANDARD_EMOJI_SHORTCODE_ENTRIES.flatMap((entry) => {
    const tier = matchTier(entry.shortcode, normalizedQuery)
    return tier === null ? [] : [{ ...entry, tier }]
  }).sort(
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
