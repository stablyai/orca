export const BOT_TAG_LIMIT = 12
export const BOT_TAG_LENGTH = 32

export function truncateBotTag(value: string): string {
  return Array.from(value).slice(0, BOT_TAG_LENGTH).join('')
}

export function normalizeBotTags(tags: readonly string[]): string[] {
  const byKey = new Map<string, string>()
  for (const value of tags) {
    const tag = truncateBotTag(value.trim().replace(/\s+/g, ' ')).trimEnd()
    const key = tag.toLowerCase()
    if (tag && !byKey.has(key)) {
      byKey.set(key, tag)
      if (byKey.size === BOT_TAG_LIMIT) {
        break
      }
    }
  }
  return [...byKey.values()]
}
