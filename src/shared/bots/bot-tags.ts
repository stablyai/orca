export const BOT_TAG_LIMIT = 12
export const BOT_TAG_LENGTH = 32
export const BOT_TAGS_FULL = 'bot_tags_full'

export function truncateBotTag(value: string, length = BOT_TAG_LENGTH): string {
  return Array.from(value).slice(0, length).join('')
}

/** The caret follows the edit. Keep the suffix intact and take any overflow from the insertion. */
export function limitBotTagDraft(value: string, suffixStart: number): string {
  const suffix = truncateBotTag(value.slice(suffixStart))
  return (
    truncateBotTag(value.slice(0, suffixStart), BOT_TAG_LENGTH - Array.from(suffix).length) + suffix
  )
}

export type BotTagEdit = { add: string[] } | { remove: string }

export function applyBotTagEdit(tags: readonly string[], edit: BotTagEdit): string[] {
  if ('remove' in edit) {
    const key = normalizeBotTags([edit.remove])[0]?.toLowerCase()
    return tags.filter((tag) => tag.toLowerCase() !== key)
  }
  const next = normalizeBotTags([...tags, ...edit.add], BOT_TAG_LIMIT + 1)
  if (next.length > BOT_TAG_LIMIT) {
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
