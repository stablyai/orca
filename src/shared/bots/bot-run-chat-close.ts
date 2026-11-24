// A bot automation run's own chat (one it opened, whose first message is the run) closes once the
// run is over and nothing waits on the chat; each of these keeps it, and the next check looks again.
import type { AutomationRunStatus } from '../automations/history/automation-run'
import type { BotItemStatus } from './bot-items'

export const RUN_CHAT_KEEP_REASONS = [
  /** Its run's record says it is still going. */
  'run-not-ended',
  /** Its last turn was within the quiet window. */
  'recent',
  /** A turn runs or a send waits in it. */
  'working',
  /** Mail to it that nothing read yet. */
  'unread-mail',
  /** It owns an item that is not done or canceled. */
  'open-item',
  /** An automation or wait runs in it, and would fail once it closed. */
  'automation-target',
  /** It answers a Slack, GitHub or Linear conversation. */
  'thread',
  /** A Run it coordinates has a worker still going. */
  'live-run',
  /** Someone has its tab open. */
  'tab-open',
  /** A person wrote in it after the run. */
  'person-spoke'
] as const

export type RunChatKeepReason = (typeof RUN_CHAT_KEEP_REASONS)[number]

export type RunChatFacts = Record<RunChatKeepReason, boolean>

/** A chat this quiet since its last move counts as done; scheduled runs come every 30 minutes. */
export const RUN_CHAT_QUIET_MS = 10 * 60_000

const OPEN_RUN_STATUSES: readonly AutomationRunStatus[] = ['pending', 'dispatching', 'dispatched']

/** History keeps only the newest runs per automation and drops only finished ones, so a run no
 *  longer in it ended long ago. */
export function runChatRunEnded(status: AutomationRunStatus | undefined): boolean {
  return status === undefined || !OPEN_RUN_STATUSES.includes(status)
}

/** What keeps the chat open; none means it closes. */
export function runChatKeeps(facts: RunChatFacts): RunChatKeepReason[] {
  return RUN_CHAT_KEEP_REASONS.filter((reason) => facts[reason])
}

/** `orca bot run-chats`: what a check would close now and what it keeps, and why. */
export type BotRunChatsPreview = {
  bot: string
  /** Whether the bot closes them on its own. */
  on: boolean
  /** Its open chats, the Home Chat included. */
  open: number
  /** Open chats no run opened: the Home Chat, threads, chats a person started. */
  notRunChats: number
  close: BotRunChatPreviewRow[]
  keep: (BotRunChatPreviewRow & { keep: RunChatKeepReason[] })[]
  /** Item mail of a closed chat reaches the Home Chat. */
  itemMailTo: { chatId: string; title: string | null } | null
}

export type BotRunChatPreviewRow = {
  chatId: string
  title: string | null
  lastActivityAt: number
  /** Items it owns, which stay its own once it closes. */
  items: { number: number; status: BotItemStatus }[]
}
