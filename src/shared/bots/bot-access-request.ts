// A Request access ask, as its connector vouched for it, and how granting it changes the bot's people.
import {
  BOT_MAX_MEMBERS,
  botLinearWorkspaces,
  botSlackApps,
  linearMembersOf,
  slackMembersOf,
  type Bot,
  type BotMember
} from '../bot-types'
import { CONNECTOR_CLIENT_LIMITS } from '../connectors/connector-cloud-contract'
import type { ConnectorAccessRequest } from '../connector-bot-access-contract'

const ACCESS_NOTICE_PREFIX = 'bot-access-request:'

/** The owner notice's id for a request, which a phone's push carries as its notification id. */
export function botAccessRequestNoticeId(requestId: string): string {
  return `${ACCESS_NOTICE_PREFIX}${requestId}`
}

/** The request a notice id names; null for any other notice. */
export function botAccessRequestIdOfNotice(noticeId: string | undefined): string | null {
  const requestId = noticeId?.startsWith(ACCESS_NOTICE_PREFIX)
    ? noticeId.slice(ACCESS_NOTICE_PREFIX.length)
    : ''
  return requestId || null
}

/** The name the request goes by. */
export function accessRequestPerson(request: ConnectorAccessRequest): string {
  return request.requester.name || request.requester.handle || request.requester.id
}

/** What the connector vouches for; a display name alone can be anyone's. Linear's handle can be
 *  edited and repeated, so its email leads. */
export function accessRequestIdentity({ source, requester }: ConnectorAccessRequest): string {
  const handle = requester.handle && `@${requester.handle}`
  return (source === 'linear' ? [requester.detail, handle] : [handle, requester.detail])
    .filter(Boolean)
    .join(' · ')
}

/** One connector's list of people on a bot: who it lists, and how a new person is stamped. */
export type BotMemberList = {
  listed: (members: readonly BotMember[]) => BotMember[]
  stamp: Pick<BotMember, 'source' | 'workspaceId'>
}

/** The bot's people with `picked` added to one connector's list; anyone it already lists is kept as is. */
export function addBotMembers(
  members: readonly BotMember[],
  picked: readonly BotMember[],
  list: BotMemberList
): BotMember[] {
  return [...members, ...newBotMembers(members, picked, list)]
}

/** The picked people this list doesn't have yet, stamped as its own: what an add sends the host. */
export function newBotMembers(
  members: readonly BotMember[],
  picked: readonly BotMember[],
  list: BotMemberList
): BotMember[] {
  const listed = list.listed(members)
  return picked
    .filter((member) => !listed.some((entry) => entry.id === member.id))
    .map((member) => ({ ...member, ...list.stamp }))
}

/** The list a request's connector and workspace add to, and how many it takes; null when the bot is not there now. */
function listFor(
  bot: Bot,
  request: ConnectorAccessRequest
): (BotMemberList & { max: number }) | null {
  const { workspaceId } = request
  if (request.source === 'slack') {
    return botSlackApps(bot).some((app) => app.teamId === workspaceId)
      ? {
          listed: (members) => slackMembersOf({ ...bot, members }, workspaceId),
          stamp: { source: 'slack', workspaceId },
          max: BOT_MAX_MEMBERS
        }
      : null
  }
  return botLinearWorkspaces(bot).some((linear) => linear.workspaceId === workspaceId)
    ? {
        listed: (members) => linearMembersOf(members, workspaceId),
        stamp: { source: 'linear', workspaceId },
        max: CONNECTOR_CLIENT_LIMITS.maxBotWorkspaceMembers
      }
    : null
}

/** A request this bot can answer: its own, from the connector and workspace it is in now. */
export function botTakesAccessRequest(bot: Bot, request: ConnectorAccessRequest): boolean {
  return request.botId === bot.id && listFor(bot, request) !== null
}

export type AccessRequestGrant =
  | { kind: 'add'; members: BotMember[] }
  /** They are already listed; only the request needs closing. */
  | { kind: 'listed' }
  | { kind: 'full' }
  | { kind: 'not-this-bot' }

/** The bot's people with the requester added, through the same add the desktop's Give full access uses. */
export function grantAccessRequest(bot: Bot, request: ConnectorAccessRequest): AccessRequestGrant {
  const list = request.botId === bot.id ? listFor(bot, request) : null
  if (!list) {
    return { kind: 'not-this-bot' }
  }
  const listed = list.listed(bot.members)
  if (listed.some((member) => member.id === request.requester.id)) {
    return { kind: 'listed' }
  }
  if (bot.members.length >= BOT_MAX_MEMBERS || listed.length >= list.max) {
    return { kind: 'full' }
  }
  const { id, avatarUrl } = request.requester
  return {
    kind: 'add',
    members: addBotMembers(
      bot.members,
      [{ id, name: accessRequestPerson(request), ...(avatarUrl ? { avatarUrl } : {}) }],
      list
    )
  }
}
