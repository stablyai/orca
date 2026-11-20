// Google acts as the owner for everyone the bot takes requests from, so whoever can ask the bot can
// have it use the owner's mail, calendar and files. Said when either side of that is switched on.
import type { Bot } from '../bot-types'

/** The people other than the owner who can ask the bot (its Who can ask), by name, once each. */
export function botOtherAskers(bot: Pick<Bot, 'members'>): string[] {
  return [...new Set(bot.members.map((member) => member.name || member.id))]
}

/** Null when nobody but the owner can ask; else the warning to confirm. */
export function googleWhoCanAskWarning(botName: string, askers: readonly string[]): string | null {
  if (askers.length === 0) {
    return null
  }
  const who =
    askers.length === 1 ? askers[0] : `${askers.slice(0, -1).join(', ')} and ${askers.at(-1)}`
  return `${who} will be able to have ${botName} read and send your email, calendar and files.`
}
