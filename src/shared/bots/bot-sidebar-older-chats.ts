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
 *  and its workers' settle times. 0 when any worker the read shows finished with no settle time (it exited
 *  without reporting): finished workers sort by start, so an undated exit can sit behind a dated one and
 *  nothing proves how long ago it ended. Only the read's shown finished workers (the newest page) count. */
function settledChatDatedAt(chat: BotChatTreeChat): number {
  let settledAt = 0
  for (const worker of chat.finished) {
    const at = knownTime(worker.settledAt)
    if (at === 0) {
      return 0
    }
    settledAt = Math.max(settledAt, at)
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
  // Every line under every root (unclaimed ones too), once per host-qualified identity, with its
  // children: lineage can repeat or loop, so holds then travel back up from each held line to every line
  // that reaches it, rather than being cached part-way through a walk.
  const lines = new Map<string, T>()
  const parents = new Map<string, Set<string>>()
  const pending: T[] = [...holds.workspaces]
  for (let line = pending.pop(); line !== undefined; line = pending.pop()) {
    const identity = holds.identityOf(line)
    if (lines.has(identity)) {
      continue
    }
    lines.set(identity, line)
    for (const child of holds.childrenOf(line)) {
      const childIdentity = holds.identityOf(child)
      parents.set(childIdentity, (parents.get(childIdentity) ?? new Set()).add(identity))
      pending.push(child)
    }
  }
  const reachesHeld = new Set<string>()
  const upward = [...lines].filter(([, line]) => holds.heldLineIds.has(line.id)).map(([id]) => id)
  for (let identity = upward.pop(); identity !== undefined; identity = upward.pop()) {
    if (!reachesHeld.has(identity)) {
      reachesHeld.add(identity)
      upward.push(...(parents.get(identity) ?? []))
    }
  }
  // An id two physical workspaces share (twins on two hosts) maps to one chat however many claim it, so
  // which chat it belongs to can't be told: every chat whose lines include such an id holds. Known limit:
  // the read already placed both twins under one chat, so another chat that also claimed one isn't seen.
  const identitiesById = new Map<string, Set<string>>()
  for (const [identity, line] of lines) {
    identitiesById.set(line.id, (identitiesById.get(line.id) ?? new Set()).add(identity))
  }
  const sharedIds = new Set(
    [...identitiesById].filter(([, identities]) => identities.size > 1).map(([id]) => id)
  )
  const heldChats = new Set<string>()
  for (const root of holds.workspaces) {
    const chatId = holds.workspaceChats[root.id]
    if (chatId === undefined || heldChats.has(chatId)) {
      continue
    }
    if (reachesHeld.has(holds.identityOf(root)) || treeHasId(root, sharedIds, holds)) {
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

/** Whether any line in the root's tree has one of these ids; nothing to walk when there are none. */
function treeHasId<T extends { id: string }>(
  root: T,
  ids: ReadonlySet<string>,
  holds: Pick<OlderBotChatHolds<T>, 'childrenOf' | 'identityOf'>
): boolean {
  if (ids.size === 0) {
    return false
  }
  const seen = new Set<string>()
  const pending = [root]
  for (let line = pending.pop(); line !== undefined; line = pending.pop()) {
    const identity = holds.identityOf(line)
    if (!seen.has(identity)) {
      seen.add(identity)
      if (ids.has(line.id)) {
        return true
      }
      pending.push(...holds.childrenOf(line))
    }
  }
  return false
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
