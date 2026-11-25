// A mascot reaches Slack as a 512 px PNG a window draws from today's art (its tile color and outfit, or
// neither), kept in the bot's host's app data under a name that says which look it shows, so a stale one is
// never sent for a newer look. Until one is drawn, the host leaves the last drawing (or, with none, sends the
// mascot id).
import { parseBotAvatar } from '../bot-avatar'
import type { Bot } from '../bot-types'
import { DEFAULT_BOT_AVATAR_COLOR } from './bot-avatar-color'

// Bump the version of an affected look when its artwork changes.
const SLACK_ICON_ART_VERSION = 'v1'

// As BotAvatarColorSchema and BotStoredOutfitSchema take them.
const COLOR = /^#[0-9a-f]{6}$/
const OUTFIT = /^[a-z0-9-]{1,40}$/
const SLACK_ICON_FILE = /^v\d+(?:-[A-Za-z0-9]+)+\.png$/

type LookedBot = Pick<Bot, 'avatar' | 'avatarColor' | 'avatarOutfit'>

/** The look a drawn icon must show, as a file-name-safe key; null when the picture is not a mascot. */
export function botSlackIconLook(bot: LookedBot): string | null {
  const parsed = parseBotAvatar(bot.avatar)
  if (parsed?.kind !== 'mascot') {
    return null
  }
  // Plain checks, not the schemas: this runs per bot on each of the host's avatar passes.
  const color =
    typeof bot.avatarColor === 'string' && COLOR.test(bot.avatarColor) ? bot.avatarColor : null
  const outfit =
    typeof bot.avatarOutfit === 'string' && OUTFIT.test(bot.avatarOutfit) ? bot.avatarOutfit : null
  const tile = color && color !== DEFAULT_BOT_AVATAR_COLOR ? color.slice(1) : null
  const artVersion = parsed.id === 'G1' && outfit === 'hard-hat' ? 'v2' : SLACK_ICON_ART_VERSION
  return [artVersion, parsed.id, tile ?? 'plain', outfit ?? 'none'].join('-')
}

export function botSlackIconFile(look: string): string {
  return `${look}.png`
}

/** A drawn icon's file name, as Orca writes them; anything else in the folder is left alone. */
export function isBotSlackIconFile(name: string): boolean {
  return SLACK_ICON_FILE.test(name)
}
