// Which of a bot's sidebar chats fold under its "Show N older" toggle: presentation only, nothing closes.
import { chatIsGoing, type BotChatTreeChat } from './bot-chat-tree'
import type { BotSidebarChatView } from './bot-sidebar-tree'

/** A settled chat this long unmoved, unchanged and unfocused, folds. */
export const OLDER_BOT_CHAT_AGE_MS = 24 * 60 * 60 * 1000

/** Fewer than this due, nothing folds: a toggle in place of one row saves nothing. */
const OLDER_BOT_CHATS_MIN = 2

/** A time usable as age evidence: finite and positive; anything else proves nothing. */
function knownTime(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** When a settled chat's outcome is dated: a day of quiet is measured from the latest of its turn, mail
 *  and newest worker's settle time. 0 when its newest worker finished with no settle time (it exited
 *  without reporting), so nothing proves how long it has been quiet. */
function settledChatDatedAt(chat: BotChatTreeChat): number {
  const newest = chat.finished[0]
  const settledAt = newest ? knownTime(newest.settledAt) : 0
  if (newest && settledAt === 0) {
    return 0
  }
  return Math.max(knownTime(chat.lastActiveAt), knownTime(chat.turnDone?.at), settledAt)
}

export type OlderBotChatHolds<T> = {
  /** When each chat tab was last focused, by the session id it shows (the chat's, or its successor's after /clear). */
  focusedAt: ReadonlyMap<string, number>
  /** Session ids held whatever their timestamps: the tab in front, a Reveal current target. */
  heldSessionIds: ReadonlySet<string>
  /** Workspaces held wherever they sit, by id: live, waiting on the owner, open, revealed. */
  heldLineIds: ReadonlySet<string>
  /** Every workspace of the bot, not only the paged ones shown, and the chat each sits under. */
  workspaces: readonly T[]
  workspaceChats: Readonly<Record<string, string>>
  childrenOf: (line: T) => readonly T[]
  /** A workspace's identity across hosts: two hosts can publish the same id. */
  identityOf: (line: T) => string
}

/** When each listed chat may fold: Infinity while something holds it (Home, going or waiting on the owner,
 *  no dated outcome, a held workspace in its tree, in front or revealed), else a day after its dated
 *  outcome or its tab's last focus, whichever is later. Needs no clock, so a tick only compares. */
export function botSidebarChatFoldTimes<T extends { id: string }>(
  chats: readonly BotChatTreeChat[],
  holds: OlderBotChatHolds<T>
): Map<string, number> {
  // Each line is walked once across all chats, by identity; one met again in its own lineage adds nothing.
  const walked = new Map<string, boolean>()
  const lineHeld = (line: T): boolean => {
    const key = holds.identityOf(line)
    const known = walked.get(key)
    if (known !== undefined) {
      return known
    }
    walked.set(key, false)
    const held = holds.heldLineIds.has(line.id) || holds.childrenOf(line).some(lineHeld)
    walked.set(key, held)
    return held
  }
  const heldChats = new Set<string>()
  for (const line of holds.workspaces) {
    const chatId = holds.workspaceChats[line.id]
    if (chatId !== undefined && lineHeld(line)) {
      heldChats.add(chatId)
    }
  }
  const times = new Map<string, number>()
  for (const chat of chats) {
    const ids = chat.liveSessionId ? [chat.chatId, chat.liveSessionId] : [chat.chatId]
    const datedAt = settledChatDatedAt(chat)
    const focusedAt = Math.max(0, ...ids.map((id) => knownTime(holds.focusedAt.get(id))))
    const held =
      chat.origin === 'home' ||
      chatIsGoing(chat) ||
      datedAt === 0 ||
      heldChats.has(chat.chatId) ||
      ids.some((id) => holds.heldSessionIds.has(id))
    times.set(
      chat.chatId,
      held ? Number.POSITIVE_INFINITY : Math.max(datedAt, focusedAt) + OLDER_BOT_CHAT_AGE_MS
    )
  }
  return times
}

export type OlderBotSidebarChats<T> = {
  recent: BotSidebarChatView<T>[]
  older: BotSidebarChatView<T>[]
}

/** The sidebar's chats split into those that list and those folded as older, each in the given order:
 *  a chat folds once its fold time is at or before `now`, and only when two or more do. */
export function splitOlderBotSidebarChats<T>(
  views: readonly BotSidebarChatView<T>[],
  foldTimes: ReadonlyMap<string, number>,
  now: number,
  /** While set, only these may stay folded and nothing new folds (owner over or in the list, no fresh read). */
  keepFoldedOnly: ReadonlySet<string> | null
): OlderBotSidebarChats<T> {
  const due = (view: BotSidebarChatView<T>): boolean =>
    Number.isFinite(now) &&
    (foldTimes.get(view.chat.chatId) ?? Number.POSITIVE_INFINITY) <= now &&
    (keepFoldedOnly === null || keepFoldedOnly.has(view.chat.chatId))
  const older = views.filter(due)
  if (older.length < OLDER_BOT_CHATS_MIN) {
    return { recent: [...views], older: [] }
  }
  const olderIds = new Set(older.map((view) => view.chat.chatId))
  return { recent: views.filter((view) => !olderIds.has(view.chat.chatId)), older }
}
