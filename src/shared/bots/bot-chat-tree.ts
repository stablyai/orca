// A bot's chats with the workers each one started nested under it: the Activity panel's and sidebar's one list.
import { isBotGroupMemberSession } from './bot-group'

/** What a chat row's icon shows: Home Chat, an outside thread's mark, an automation or a side chat. */
export type BotChatOrigin = 'home' | 'slack' | 'linear' | 'github' | 'automation' | 'side'

export type BotChatTreeWorker = {
  key: string
  title: string
  branch?: string
  /** `unreachable`: open, but its host can't say how it is (out of contact, or no status). */
  state: 'running' | 'needs-you' | 'asking-bot' | 'unreachable' | 'done' | 'failed'
  startedAt: number
  settledAt?: number
  worktreeId?: string
  paneKey?: string
  note?: 'handed-over' | 'from-closed-chat' | 'automation-terminal'
  /** Stop and open go through it; absent for a handed-over agent. */
  dispatchId?: string
  /** `runtime:<id>` when the workspace runs on another paired computer. */
  hostId?: string
  agent?: string
  summary?: string
  /** A terminal-only automation run, opened as a run rather than a pane. */
  run?: { automationId: string; runId: string }
}

export type BotChatTreeChat = {
  chatId: string
  title: string
  origin: BotChatOrigin
  /** The thread's place or the automation's name, e.g. '#orca'. */
  originLabel?: string
  live: 'replying' | 'needs-you' | 'idle'
  lastActiveAt: number
  /** Filled by each client from its own acks against `turnDone`; the host can't know them. */
  unread: boolean
  /** The chat's finished turn still showing: its status row's pane key and when it finished. */
  turnDone?: { paneKey: string; at: number }
  closed: boolean
  closedAt?: number
  /** Its tab is open on the bot's host; absent from an older host. */
  tab?: boolean
  /** A thread the bot started on its own that the owner has not opened yet. */
  unseen?: boolean
  /** A terminal-only automation run, listed as a chat of its own: opening it reveals its terminal. */
  run?: { automationId: string; runId: string; worktreeId?: string; paneKey?: string }
  /** Line 2: the last thing said. */
  preview?: string
  /** Needs-you first, then newest; up to the page the host was asked for. */
  running: BotChatTreeWorker[]
  runningTotal: number
  /** Newest settled first; the last `finishedShown`, or a later page. */
  finished: BotChatTreeWorker[]
  finishedTotal: number
  /** Of `finishedTotal`, how many failed, for the folded line. */
  failedTotal: number
}

/** `bots.chatTree`'s full read. */
export type BotChatTreeRead = {
  chats: BotChatTreeChat[]
  /** Every workspace under the bot, by the chat it sits under (Home Chat when none has it). */
  workspaceChats: Record<string, string>
}

export const CHAT_TREE_CAPS = {
  runningShown: 5,
  finishedShown: 2,
  step: 8
} as const

/** A chat or one of its workers waits on the owner. */
function waitsOnOwner(chat: BotChatTreeChat): boolean {
  return chat.live === 'needs-you' || chat.running.some((worker) => worker.state === 'needs-you')
}

function orderRank(chat: BotChatTreeChat): number {
  if (chat.origin === 'home' && !chat.closed) {
    return 0
  }
  if (chat.closed) {
    return 4
  }
  if (waitsOnOwner(chat)) {
    return 1
  }
  if (chat.live === 'replying') {
    return 2
  }
  return 3
}

/** Home pinned, then chats waiting on the owner, then replying, then newest; closed last. */
export function orderBotChats(chats: readonly BotChatTreeChat[]): BotChatTreeChat[] {
  return [...chats].sort((a, b) => orderRank(a) - orderRank(b) || b.lastActiveAt - a.lastActiveAt)
}

/** Something in it runs, replies or waits on the owner. */
export function chatIsGoing(chat: BotChatTreeChat): boolean {
  return chat.live !== 'idle' || chat.runningTotal > 0
}

/** A chat's workers waiting on the owner. */
export function chatWaitingCount(chat: BotChatTreeChat): number {
  return chat.running.filter((worker) => worker.state === 'needs-you').length
}

/** A chat's workers still running, not counting those waiting on the owner or out of sight. */
export function chatRunningCount(chat: BotChatTreeChat): number {
  // A worker its host can't see is not counted as running.
  const notRunning = chat.running.filter(
    (worker) => worker.state === 'needs-you' || worker.state === 'unreachable'
  ).length
  return chat.runningTotal - notRunning
}

/** A folded chat's live counts, '1 waiting · 3 running'; null when nothing runs, so the row shows its time. */
export function chatFoldSummary(chat: BotChatTreeChat): string | null {
  const waiting = chatWaitingCount(chat)
  const running = chatRunningCount(chat)
  const parts = [
    waiting > 0 ? `${waiting} waiting` : null,
    running > 0 ? `${running} running` : null
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** A manual fold; a chat with none starts folded. */
export type BotChatFold = 'open' | 'folded'

/** One chat of one bot on one host: bot ids are per host, chat ids per bot. */
export function botChatFoldKey(hostId: string, botId: string, chatId: string): string {
  return `${hostId}\u0000${botId}\u0000${chatId}`
}

/** Folds kept; the oldest choices go first past this. */
export const BOT_CHAT_FOLDS_MAX = 500

/** The persisted folds with one choice set (or cleared with null), newest last, capped. */
export function withBotChatFold(
  folds: Readonly<Record<string, BotChatFold>>,
  key: string,
  fold: BotChatFold | null
): Record<string, BotChatFold> {
  const next = Object.entries(folds).filter(([existing]) => existing !== key)
  if (fold) {
    next.push([key, fold])
  }
  return Object.fromEntries(next.slice(-BOT_CHAT_FOLDS_MAX))
}

export function normalizeBotChatFolds(value: unknown): Record<string, BotChatFold> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, BotChatFold] => entry[1] === 'open' || entry[1] === 'folded'
  )
  return Object.fromEntries(entries.slice(-BOT_CHAT_FOLDS_MAX))
}

/** The bot's chats as its own lists show them: a group room session belongs to its room, so its row
 *  drops, and its workers move under Home Chat, where anything without a chat goes; every worker that
 *  waits on the owner keeps a row. With no Home Chat to take them, nothing moves. Finished workers
 *  past the room's shown page stay out: Home's Show more reads only Home's. */
export function botOwnChatTree<T extends BotChatTreeRead>(tree: T): T {
  const rooms = tree.chats.filter((chat) => isBotGroupMemberSession(chat.chatId))
  const home = tree.chats.find((chat) => chat.origin === 'home' && !chat.closed)
  if (rooms.length === 0 || !home) {
    return tree
  }
  const roomIds = new Set(rooms.map((chat) => chat.chatId))
  const moved = rooms.flatMap((chat) => chat.finished)
  const merged: BotChatTreeChat = {
    ...home,
    running: [...home.running, ...rooms.flatMap((chat) => chat.running)].toSorted(
      (a, b) => Number(b.state === 'needs-you') - Number(a.state === 'needs-you')
    ),
    runningTotal: rooms.reduce((sum, chat) => sum + chat.runningTotal, home.runningTotal),
    finished: [...home.finished, ...moved].toSorted(
      (a, b) => (b.settledAt ?? b.startedAt) - (a.settledAt ?? a.startedAt)
    ),
    finishedTotal: home.finishedTotal + moved.length,
    failedTotal: home.failedTotal + moved.filter((worker) => worker.state === 'failed').length
  }
  const workspaceChats = Object.fromEntries(
    Object.entries(tree.workspaceChats).map(([workspace, chatId]) => [
      workspace,
      roomIds.has(chatId) ? home.chatId : chatId
    ])
  )
  return {
    ...tree,
    chats: tree.chats.flatMap((chat) =>
      roomIds.has(chat.chatId) ? [] : chat === home ? [merged] : [chat]
    ),
    workspaceChats
  }
}
