export const BOT_TAG_LIMIT = 12
export const BOT_TAG_LENGTH = 32
export const BOT_TAGS_FULL = 'bot_tags_full'

export function truncateBotTag(value: string, length = BOT_TAG_LENGTH): string {
  return Array.from(value).slice(0, length).join('')
}

/** Limit the tag at the caret, keeping its suffix and the other tags intact. */
export function limitBotTagDraft(value: string, suffixStart: number): string {
  const tagStart = suffixStart > 0 ? value.lastIndexOf(',', suffixStart - 1) + 1 : 0
  const delimiter = value.indexOf(',', suffixStart)
  const prefix = value.slice(tagStart, suffixStart)
  const suffix = value.slice(suffixStart, delimiter === -1 ? undefined : delimiter)
  const inList = tagStart > 0 || delimiter !== -1
  const tagPrefix = inList ? prefix.trimStart() : prefix
  const tagSuffix = inList ? suffix.trimEnd() : suffix
  const available = Math.max(0, BOT_TAG_LENGTH - Array.from(tagSuffix).length)
  return (
    value.slice(0, suffixStart - tagPrefix.length) +
    truncateBotTag(tagPrefix, available) +
    value.slice(suffixStart)
  )
}

export type BotTagEdit = { add: string[] } | { remove: string }

export function planBotTagAdds(
  tags: readonly string[],
  additions: readonly string[]
): string[] | null {
  const next = normalizeBotTags([...tags, ...additions], BOT_TAG_LIMIT + 1)
  return next.length <= BOT_TAG_LIMIT ? next : null
}

export function applyBotTagEdit(tags: readonly string[], edit: BotTagEdit): string[] {
  if ('remove' in edit) {
    const key = normalizeBotTags([edit.remove])[0]?.toLowerCase()
    return tags.filter((tag) => tag.toLowerCase() !== key)
  }
  const next = planBotTagAdds(tags, edit.add)
  if (!next) {
    throw new Error(BOT_TAGS_FULL)
  }
  return next
}

export function normalizeBotTags(tags: readonly string[], limit = BOT_TAG_LIMIT): string[] {
  const byKey = new Map<string, string>()
  for (const value of tags) {
    const tag = truncateBotTag(value.trim().replace(/\s+/g, ' ')).trimEnd()
    const key = tag.toLowerCase()
    if (tag && !byKey.has(key)) {
      byKey.set(key, tag)
      if (byKey.size === limit) {
        break
      }
    }
  }
  return [...byKey.values()]
}
