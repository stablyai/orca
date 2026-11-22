// A bot side chat whose items are all done or canceled closes itself after a short countdown, unless
// something in it is still going, the owner is in it, or the owner kept it open.
export const BOT_CHAT_AUTO_CLOSE_MS = 2 * 60_000

/** A desktop renews its hold well inside this; a closed window's hold lapses on its own. */
export const BOT_CHAT_AUTO_CLOSE_HOLD_LEASE_MS = 30_000

/** What a chat's strip and row show: counting down to `closesAt`, paused while someone is in it or
 *  has an unsent message, or kept open until new work finishes. */
export type BotChatAutoCloseView =
  | { phase: 'counting'; closesAt: number }
  | { phase: 'held' }
  | { phase: 'kept' }

/** What one chat's items say: how many, how many still open, and the latest close. */
export type BotChatItemFacts = { total: number; open: number; lastClosedAt: number | null }

/** Everything the close rule reads about one chat, read fresh each time. */
export type BotChatCloseFacts = {
  chat: { origin: string; live: string; runningTotal: number; closed: boolean }
  /** A group room's member session: its room owns it. */
  room: boolean
  items: BotChatItemFacts
  /** Waits and automations that run in this chat. */
  waits: number
  /** Its last turn failed and holds its mail until the owner resumes. */
  failedTurn: boolean
  /** Mail addressed to it not yet read. */
  queuedMail: number
}

export type BotChatCloseBlocker =
  | 'not-side'
  | 'room'
  | 'closed'
  | 'no-items'
  | 'open-items'
  | 'workers'
  | 'busy'
  | 'waits'
  | 'failed-turn'
  | 'mail'

/** Why the chat must stay open, or null when every item it drove is done or canceled and nothing in
 *  it still runs, asks, waits or has mail coming. */
export function botChatCloseBlocker(facts: BotChatCloseFacts): BotChatCloseBlocker | null {
  const { chat, items } = facts
  if (chat.origin !== 'side') {
    return 'not-side'
  }
  if (facts.room) {
    return 'room'
  }
  if (chat.closed) {
    return 'closed'
  }
  if (items.total === 0) {
    return 'no-items'
  }
  if (items.open > 0) {
    return 'open-items'
  }
  if (chat.runningTotal > 0) {
    return 'workers'
  }
  if (chat.live !== 'idle') {
    return 'busy'
  }
  if (facts.waits > 0) {
    return 'waits'
  }
  if (facts.failedTurn) {
    return 'failed-turn'
  }
  return facts.queuedMail > 0 ? 'mail' : null
}

/** Changes when an item is added, reopened or closed again, so a Keep open made against an older set
 *  stops applying. */
export function botChatItemStamp(items: BotChatItemFacts): string {
  return `${items.total}:${items.open}:${items.lastClosedAt ?? 0}`
}

/** One chat of one bot: chat ids are per bot. */
export function botChatAutoCloseKey(botId: string, chatId: string): string {
  return `${botId}\u0000${chatId}`
}

/** The host's answer, read leniently: anything unknown is no countdown. */
export function readBotChatAutoCloseView(value: unknown): BotChatAutoCloseView | null {
  if (!value || typeof value !== 'object' || !('phase' in value)) {
    return null
  }
  if (value.phase === 'held' || value.phase === 'kept') {
    return { phase: value.phase }
  }
  return value.phase === 'counting' &&
    'closesAt' in value &&
    typeof value.closesAt === 'number' &&
    Number.isFinite(value.closesAt)
    ? { phase: 'counting', closesAt: value.closesAt }
    : null
}

/** A desktop holds a counting or paused chat while it is in front of a focused window or has an
 *  unsent message there; never once it is kept open. */
export function botChatAutoCloseHolds(input: {
  view: BotChatAutoCloseView | null
  visible: boolean
  focused: boolean
  unsent: boolean
}): boolean {
  return (
    input.view !== null &&
    input.view.phase !== 'kept' &&
    ((input.visible && input.focused) || input.unsent)
  )
}
