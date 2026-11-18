import {
  botLinearWorkspaces,
  botSlackApps,
  type Bot,
  type BotLinearLink,
  type BotSlackLink
} from './bot-types'

/** A link keeps the account it was made under; a new one takes the account signed in now. */
export function stampBotLinkOwners(
  previous: Bot,
  next: Bot,
  accountUserId: () => string | null
): Bot {
  const stamp = <T extends { ownerUserId?: string }>(link: T, was: T | undefined): T => {
    const ownerUserId = link.ownerUserId ?? was?.ownerUserId ?? accountUserId()
    return ownerUserId ? { ...link, ownerUserId } : link
  }
  const slackApps = botSlackApps(next).map((link): BotSlackLink => {
    const was = botSlackApps(previous).find((entry) => entry.teamId === link.teamId)
    return stamp(link, was)
  })
  const linearWorkspaces = botLinearWorkspaces(next).map((link): BotLinearLink => {
    const was = botLinearWorkspaces(previous).find(
      (entry) => entry.workspaceId === link.workspaceId
    )
    return stamp(link, was)
  })
  return {
    ...next,
    ...(next.slackApps ? { slackApps } : {}),
    slack: slackApps[0] ?? null,
    ...(next.linearWorkspaces ? { linearWorkspaces } : {}),
    linear: linearWorkspaces[0] ?? null,
    github: next.github ? stamp(next.github, previous.github ?? undefined) : null
  }
}

/** The accounts this bot's links were made under; null stands for a link with no recorded owner. */
export function botLinkOwners(bot: Bot): (string | null)[] {
  return [
    ...botSlackApps(bot),
    ...botLinearWorkspaces(bot),
    ...(bot.github ? [bot.github] : [])
  ].map((link) => link.ownerUserId ?? null)
}
