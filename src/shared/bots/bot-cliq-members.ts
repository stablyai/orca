// A bot's Cliq people belong to the organization they were added in, so removing that
// organization's Cliq bot removes them too.
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import {
  BOT_MAX_CONNECTOR_WORKSPACES,
  BotCliqBotSchema,
  botMemberSource,
  botMembersFrom,
  type Bot,
  type BotMember
} from '../bot-types'

/** Every organization the bot has a Cliq bot in, as an update sets it; an org's people go with it. */
export const BotCliqBotsUpdateSchema = lazyZodSchema(() =>
  z.array(BotCliqBotSchema).max(BOT_MAX_CONNECTOR_WORKSPACES).optional()
)

/** The bot once Cliq people outside its `cliqBots`' organizations (or untagged) are gone; without the list, as it is. */
export function withCliqMembersIn(bot: Bot): Bot {
  if (!bot.cliqBots) {
    return bot
  }
  const orgs = new Set(bot.cliqBots.map((link) => link.orgId))
  const members = bot.members.filter(
    (member) =>
      botMemberSource(member) !== 'cliq' ||
      (member.workspaceId !== undefined && orgs.has(member.workspaceId))
  )
  return { ...bot, members }
}

/** The Cliq people (Zoho user ids) allowed to ask the bot in one organization. */
export function cliqMembersOf(members: readonly BotMember[], orgId: string): BotMember[] {
  return botMembersFrom(members, 'cliq').filter((member) => member.workspaceId === orgId)
}
