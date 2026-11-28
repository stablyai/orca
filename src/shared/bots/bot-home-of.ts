// Whose Home Chat an agent's chat is: each person the agent works with has one. The owner's pointer is
// Bot.chatSessionId; a teammate's is homeSessionId on their account share. The only module that knows.
import type { Bot } from '../bot-types'
import type { AutomationBotTarget } from '../automation-bot-target'
import {
  OWNER_ACTS_FOR,
  shareOwnsChat,
  type BotRequestAsker,
  type BotRequestPerson
} from './bot-acts-for'
import { botShareUsable, type BotAccountShare, type BotShare } from './bot-team-shares'

export type BotHomeOf = 'owner' | { accountId: string }

type HomeBot = Pick<Bot, 'chatSessionId' | 'shares'>

/** The home chat title Orca gives an agent's Chat; the owner's Home keeps it. */
export const BOT_HOME_NAME = 'Home'

function usableAccountShare(bot: Pick<Bot, 'shares'>, accountId: string): BotAccountShare | null {
  const share = bot.shares?.find(
    (entry): entry is BotAccountShare => entry.kind === 'account' && entry.accountId === accountId
  )
  return share && botShareUsable(share) ? share : null
}

/** The Home session id, null until first opened (or while that teammate's share is gone). */
export function botHome(bot: HomeBot, of: BotHomeOf): string | null {
  return of === 'owner'
    ? bot.chatSessionId
    : (usableAccountShare(bot, of.accountId)?.homeSessionId ?? null)
}

/** Every Home made so far: the owner's first, then each usable account share's. */
export function botHomes(bot: HomeBot): { of: BotHomeOf; sessionId: string; name?: string }[] {
  const owner = bot.chatSessionId ? [{ of: 'owner' as const, sessionId: bot.chatSessionId }] : []
  const teammates = (bot.shares ?? []).flatMap((share) =>
    share.kind === 'account' && botShareUsable(share) && share.homeSessionId
      ? [
          {
            of: { accountId: share.accountId },
            sessionId: share.homeSessionId,
            name: share.name ?? share.email
          }
        ]
      : []
  )
  return [...owner, ...teammates]
}

/** Whether that person may have a Home: the owner always; a teammate while their share is usable. */
export function botHomeOpenable(bot: Pick<Bot, 'shares'>, of: BotHomeOf): boolean {
  return of === 'owner' || usableAccountShare(bot, of.accountId) !== null
}

/** Each Home's /clear root, by whose Home it is. */
export function botHomeRoots(
  bot: HomeBot,
  rootOf: (sessionId: string) => string
): Map<string, BotHomeOf> {
  return new Map(botHomes(bot).map((home) => [rootOf(home.sessionId), home.of]))
}

/** The saved edit naming `sessionId` as that person's Home; throws bot_not_shared when their share
 *  is gone or declined, so a Home write never brings back a removed row. */
export function withBotHome(
  bot: HomeBot,
  of: BotHomeOf,
  sessionId: string
): Pick<Bot, 'chatSessionId'> | Pick<Bot, 'shares'> {
  if (of === 'owner') {
    return { chatSessionId: sessionId }
  }
  const share = usableAccountShare(bot, of.accountId)
  if (!share) {
    throw new Error('bot_not_shared')
  }
  return {
    shares: bot.shares?.map((entry) =>
      entry === share ? { ...share, homeSessionId: sessionId } : entry
    )
  }
}

/** The shares with every Home pointer to a deleted session cleared: a pointer only names a chat that
 *  exists. The same `shares` back when none names one. */
export function withoutBotHome(
  bot: Pick<Bot, 'shares'>,
  deletedSessionIds: ReadonlySet<string>
): Pick<Bot, 'shares'> {
  const named = (share: BotShare) =>
    share.kind === 'account' &&
    share.homeSessionId !== undefined &&
    deletedSessionIds.has(share.homeSessionId)
  if (!bot.shares?.some(named)) {
    return { shares: bot.shares }
  }
  return {
    shares: bot.shares.map((share) => {
      if (!named(share) || share.kind !== 'account') {
        return share
      }
      const { homeSessionId: _gone, ...rest } = share
      return rest
    })
  }
}

/** Whose Home a chat acting for `actsFor` falls back to: the usable teammate it acts for alone, else the owner. */
export function botHomeOfActsFor(
  bot: Pick<Bot, 'shares'>,
  actsFor: readonly BotRequestAsker[]
): BotHomeOf {
  const share = bot.shares?.find(
    (entry): entry is BotAccountShare =>
      entry.kind === 'account' && botShareUsable(entry) && shareOwnsChat(actsFor, entry.accountId)
  )
  return share ? { accountId: share.accountId } : 'owner'
}

/** A key per person, for locks and maps. */
export function botHomeKey(of: BotHomeOf): string {
  return of === 'owner' ? 'owner' : `account:${of.accountId}`
}

export function sameBotHome(left: BotHomeOf, right: BotHomeOf): boolean {
  return botHomeKey(left) === botHomeKey(right)
}

/** A teammate as their share row names them (name, else email), else by account id. */
export function botSharePersonName(bot: Pick<Bot, 'shares'>, accountId: string): string {
  const share = bot.shares?.find(
    (entry): entry is BotAccountShare => entry.kind === 'account' && entry.accountId === accountId
  )
  return share?.name ?? share?.email ?? accountId
}

/** "<Name>’s Home": another person's Home, as anyone but its person reads it. */
export function personHomeName(person: string): string {
  return `${person}’s ${BOT_HOME_NAME}`
}

/** The owner's name to a teammate: their Orca account's, else this (a signed-out host). */
export const BOT_OWNER_FALLBACK_NAME = 'Owner'

/** The owner's Home as a teammate reads it. */
export function ownerHomeName(ownerName: string | null | undefined): string {
  return personHomeName(ownerName ?? BOT_OWNER_FALLBACK_NAME)
}

/** "Home" for the owner's; "<Name>’s Home" for a teammate's. */
export function botHomeName(bot: Pick<Bot, 'shares'>, of: BotHomeOf): string {
  return of === 'owner' ? BOT_HOME_NAME : personHomeName(botSharePersonName(bot, of.accountId))
}

/** Every name an older build may have saved on a teammate's Home ("<name>’s Home", by the name the
 *  share had then: its display name, else its email, else the account id). */
export function legacyTeammateHomeNames(
  bot: Pick<Bot, 'shares'>,
  of: Exclude<BotHomeOf, 'owner'>
): string[] {
  const share = bot.shares?.find(
    (entry): entry is BotAccountShare =>
      entry.kind === 'account' && entry.accountId === of.accountId
  )
  const people = [share?.name, share?.email, of.accountId].filter((name): name is string =>
    Boolean(name)
  )
  return [...new Set(people)].map(personHomeName)
}

/** Whether this chat is the viewer's own Home slot (the owner's Home on their computer, a teammate's on
 *  theirs), shown as "Home" whatever the host named it. A teammate's Home on the owner's computer is
 *  titled by the host's chat records (agent-session-record-home-names.ts), never here. */
export function isOwnBotHome(bot: Pick<Bot, 'chatSessionId'> | null, sessionId: string): boolean {
  return bot !== null && bot.chatSessionId === sessionId
}

/** Whose Home this session is, compared by /clear root; null for any other chat. A renderer has no
 *  resolver and compares ids as they are, as its tab check does. */
export function botHomeOfSession(
  bot: HomeBot,
  sessionId: string,
  rootOf: (sessionId: string) => string = (id) => id
): BotHomeOf | null {
  const root = rootOf(sessionId)
  return botHomes(bot).find((home) => rootOf(home.sessionId) === root)?.of ?? null
}

/** The chat tree's key for a teammate's Home not made yet, which a closed chat's work can still sit under. */
export function botHomePlaceholderId(accountId: string): string {
  return `no-home:${accountId}`
}

/** The account a placeholder row stands for, else null. */
export function botHomePlaceholderAccount(chatId: string): string | null {
  const prefix = botHomePlaceholderId('')
  return chatId.startsWith(prefix) && chatId.length > prefix.length
    ? chatId.slice(prefix.length)
    : null
}

/** The member asker for an account: as its usable row names it (name, else email), else by its id alone. */
export function botShareAskerOf(bot: Pick<Bot, 'shares'>, accountId: string): BotRequestPerson {
  const share = usableAccountShare(bot, accountId)
  return memberAsker(accountId, share ? (share.name ?? share.email) : null)
}

function memberAsker(accountId: string, name: string | null): BotRequestPerson {
  return {
    kind: 'person',
    source: 'orca',
    userId: accountId,
    ...(name ? { name } : {}),
    workspaceId: null,
    role: 'member'
  }
}

/** Whom a person's Home acts for: the owner, or that teammate as a member, never with owner powers. */
export function botHomeActsFor(bot: Pick<Bot, 'shares'>, of: BotHomeOf): BotRequestAsker[] {
  return of === 'owner' ? [...OWNER_ACTS_FOR] : [botShareAskerOf(bot, of.accountId)]
}

/** Whom an automation's runs act for: the teammate it was made for, else the owner. */
export function automationActsFor(
  bot: Pick<Bot, 'shares'>,
  target: Pick<AutomationBotTarget, 'home'> | undefined
): BotRequestAsker[] {
  return botHomeActsFor(bot, target?.home ? { accountId: target.home } : 'owner')
}

/** `automationActsFor` as a run's message records it, named through the host's lookup. */
export function runActsFor(
  run: { home?: string },
  personName: (accountId: string) => string | null
): BotRequestAsker[] {
  return run.home ? [memberAsker(run.home, personName(run.home))] : [...OWNER_ACTS_FOR]
}

/** Whose Home an automation's "chat" runs and results use: its stamped teammate, else the chat it was
 *  made in (waits saved before stamping), else the owner. */
export function automationHomeOf(
  target: Pick<AutomationBotTarget, 'home' | 'chat'>,
  homeOfChat: (sessionId: string) => BotHomeOf
): BotHomeOf {
  return target.home
    ? { accountId: target.home }
    : target.chat
      ? homeOfChat(target.chat.sessionId)
      : 'owner'
}
