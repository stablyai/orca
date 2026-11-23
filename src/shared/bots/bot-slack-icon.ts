// A mascot with a tile color or an outfit reaches Slack as a 512 px PNG a window draws, kept in the bot's
// host's app data under a name that says which look it shows, so a stale one is never sent for a newer look.
import { parseBotAvatar } from '../bot-avatar'
import type { Bot } from '../bot-types'
import { BotAvatarColorSchema, DEFAULT_BOT_AVATAR_COLOR } from './bot-avatar-color'
import { BotStoredOutfitSchema } from './bot-avatar-outfit'

// Bumped when the mascots' or outfits' art changes, so each icon is drawn again from the new art.
const SLACK_ICON_ART_VERSION = 'v1'

const SLACK_ICON_FILE = /^v\d+(?:-[A-Za-z0-9]+)+\.png$/

type LookedBot = Pick<Bot, 'avatar' | 'avatarColor' | 'avatarOutfit'>

/** The look a drawn icon must show, as a file-name-safe key; null when the plain mascot id says it all
 *  (no color, no outfit) or the picture is not a mascot. */
export function botSlackIconLook(bot: LookedBot): string | null {
  const parsed = parseBotAvatar(bot.avatar)
  if (parsed?.kind !== 'mascot') {
    return null
  }
  const color = BotAvatarColorSchema.safeParse(bot.avatarColor).success ? bot.avatarColor : null
  const outfit = BotStoredOutfitSchema.safeParse(bot.avatarOutfit).success ? bot.avatarOutfit : null
  const tile = color && color !== DEFAULT_BOT_AVATAR_COLOR ? color.slice(1) : null
  if (!tile && !outfit) {
    return null
  }
  return [SLACK_ICON_ART_VERSION, parsed.id, tile ?? 'plain', outfit ?? 'none'].join('-')
}

export function botSlackIconFile(look: string): string {
  return `${look}.png`
}

/** A drawn icon's file name, as Orca writes them; anything else in the folder is left alone. */
export function isBotSlackIconFile(name: string): boolean {
  return SLACK_ICON_FILE.test(name)
}
