// Which of a bot's sidebar chats fold under its "Show N older" link: presentation only, nothing closes.
import { chatIsGoing, type BotChatTreeChat } from './bot-chat-tree'
import type { BotSidebarChatView } from './bot-sidebar-tree'

/** A settled chat this long untouched, unfocused and unchanged, folds. */
export const OLDER_BOT_CHAT_AGE_MS = 24 * 60 * 60 * 1000

export type OlderBotSidebarChats<T> = {
  recent: BotSidebarChatView<T>[]
  older: BotSidebarChatView<T>[]
}

/** When anything last moved in a chat by its own record: a turn, mail, or its newest worker settling. */
function chatLastMovedAt(chat: BotChatTreeChat): number {
  const newest = chat.finished[0]
  return Math.max(
    chat.lastActiveAt,
    chat.turnDone?.at ?? 0,
    newest ? (newest.settledAt ?? newest.startedAt) : 0
  )
}

/** What a chat's row says changed between two reads; a new value restarts its age. */
export function botChatOutcomeSignature(chat: BotChatTreeChat): string {
  return [
    chat.live,
    chat.runningTotal,
    chat.finishedTotal,
    chat.failedTotal,
    chat.lastActiveAt,
    chat.turnDone?.at ?? 0
  ].join('|')
}

/** The sidebar's chats split into those that list and those that fold as older, each in the given order.
 *  A chat folds only when it is not Home, nothing in it goes or waits on the owner, it moved, changed and
 *  was focused over a day ago, its tab is not in front or revealed, and none of its workspaces (before
 *  paging) or their descendants is held. */
export function splitOlderBotSidebarChats<T extends { id: string }>(
  chats: readonly BotSidebarChatView<T>[],
  input: {
    now: number
    /** When each chat tab was last focused, by the session id it shows (the chat's, or its successor's after /clear). */
    focusedAt: ReadonlyMap<string, number>
    /** Session ids held whatever their timestamps: the tab in front, a Reveal current target. */
    heldSessionIds: ReadonlySet<string>
    /** When this client last saw each chat's row change between two reads (`botChatOutcomeSignature`). */
    changedAt: ReadonlyMap<string, number>
    /** Workspaces held wherever they sit: live, waiting on the owner, open, revealed. */
    heldLineIds: ReadonlySet<string>
    /** Every workspace of the bot, not only the paged ones shown, and the chat each sits under. */
    workspaces: readonly T[]
    workspaceChats: Readonly<Record<string, string>>
    childrenOf: (line: T) => readonly T[]
    /** While set, only these may stay folded and nothing new folds (focus in the list, a stale read). */
    keepFoldedOnly: ReadonlySet<string> | null
  }
): OlderBotSidebarChats<T> {
  const cutoff = input.now - OLDER_BOT_CHAT_AGE_MS
  // Each line is walked once across all chats; one met again inside its own lineage counts as not held.
  const held = new Map<string, boolean>()
  const holds = (line: T): boolean => {
    const known = held.get(line.id)
    if (known !== undefined) {
      return known
    }
    held.set(line.id, false)
    const result =
      input.heldLineIds.has(line.id) || input.childrenOf(line).some((child) => holds(child))
    held.set(line.id, result)
    return result
  }
  const heldChats = new Set<string>()
  for (const line of input.workspaces) {
    const chatId = input.workspaceChats[line.id]
    if (holds(line) && chatId !== undefined) {
      heldChats.add(chatId)
    }
  }
  const isOlder = ({ chat }: BotSidebarChatView<T>): boolean => {
    const ids = chat.liveSessionId ? [chat.chatId, chat.liveSessionId] : [chat.chatId]
    const movedAt = Math.max(chatLastMovedAt(chat), input.changedAt.get(chat.chatId) ?? 0)
    return (
      chat.origin !== 'home' &&
      !chatIsGoing(chat) &&
      movedAt > 0 &&
      movedAt <= cutoff &&
      !heldChats.has(chat.chatId) &&
      !ids.some((id) => input.heldSessionIds.has(id) || (input.focusedAt.get(id) ?? 0) > cutoff) &&
      (input.keepFoldedOnly === null || input.keepFoldedOnly.has(chat.chatId))
    )
  }
  const older = chats.filter(isOlder)
  if (older.length === 0) {
    return { recent: [...chats], older }
  }
  const olderIds = new Set(older.map((view) => view.chat.chatId))
  return { recent: chats.filter((view) => !olderIds.has(view.chat.chatId)), older }
}
