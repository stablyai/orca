import { parseBotAvatar } from '../bot-avatar'
import type { Bot } from '../bot-types'

/** What the tile shows without a picture: an emoji from before mascots, else the initial. */
export function botFallback(bot: Pick<Bot, 'name' | 'avatar'>): string {
  const parsed = parseBotAvatar(bot.avatar)
  return parsed?.kind === 'emoji' ? parsed.emoji : botInitial(bot.name)
}

/** The avatar tile's letter when the bot has no picture. */
export function botInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}
