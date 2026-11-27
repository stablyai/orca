// Activity as an inbox (app rail on): it lists what is addressed to you, requests only you can move and
// outcomes you haven't read, never work that is merely running. Live progress stays on workspace cards.
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { Bot } from '../../../../../shared/bot-types'
import { migrationUnsupportedToAgentStatusEntry } from '../../../../../shared/agent-status/presentation/migration-unsupported-agent-entry'
import {
  readBotHostState,
  readBotItemsNeedingOwner,
  readBotNeedsYouOthersLast,
  readBots
} from '@/lib/bot-catalog-snapshot'
import type { HostAccessRequest } from '@/lib/bot-access-requests'
import { readBotItemsSeen } from '@/lib/bot-items-seen'
import {
  freshActivityLiveAgentState,
  isHistoricalActivityState
} from '../events/activity-event-state'
import { activityThreadStatusId } from '../threads/activity-thread-presentation'
import { agentVerdictDisplayMark } from '../../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import type { AgentPaneThread } from '../threads/activity-thread-types'

const ASK_STATUSES: ReadonlySet<string> = new Set(['waiting', 'blocked', 'permission'])
const OUTCOME_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'unconfirmed'])

export type ActivityInboxKind = 'ask' | 'outcome'

/**
 * Where a thread sits in the inbox: an ask waits on you; an outcome is a finished turn. Running, idle and stopped work
 * is never listed (null); its live progress stays on the workspace cards.
 */
export function activityInboxKind(thread: AgentPaneThread): ActivityInboxKind | null {
  if (isChildWorkerThread(thread)) {
    return null
  }
  if (thread.migrationUnsupportedPtyId !== undefined) {
    return 'ask'
  }
  const status = activityThreadStatusId(thread)
  if (ASK_STATUSES.has(status)) {
    // A wait whose agent went quiet still asks only while unread; the rail dot reads it the same way.
    return thread.currentAgentState || thread.unread ? 'ask' : null
  }
  return OUTCOME_STATUSES.has(status) ? 'outcome' : null
}

/**
 * An agent blocked on you right now (a live question or permission ask, or a pane that must be restarted): a to-do,
 * like an access request. It stays listed, and lights the dot, until it is answered, read or not; Mark all read
 * leaves it alone. Only a wait whose agent went quiet is news that leaves once read.
 */
export function isActivityInboxToDo(thread: AgentPaneThread): boolean {
  if (thread.migrationUnsupportedPtyId !== undefined) {
    return !isChildWorkerThread(thread)
  }
  return (
    activityInboxKind(thread) === 'ask' &&
    (thread.currentAgentState === 'waiting' || thread.currentAgentState === 'blocked')
  )
}

/** A dispatched worker reports to its coordinator, not to you; its coordinator's row speaks for it. */
export function isChildWorkerEntry(
  entry: Pick<AgentStatusEntry, 'orchestration'> | null | undefined
): boolean {
  return entry?.orchestration !== undefined
}

function isChildWorkerThread(thread: AgentPaneThread): boolean {
  return (
    isChildWorkerEntry(thread.currentAgentEntry) ||
    isChildWorkerEntry(thread.paneEntry) ||
    isChildWorkerEntry(thread.latestEvent?.entry)
  )
}

/**
 * Whether one pane lights the dot, by the same rules the list's status and `activityInboxKind` use, so the dot
 * never lights for a row the list leaves out (or misses one it lists). Only the current turn counts.
 */
// 'failed' is an outcome the list keeps even for a bot: a failure is something only you can fix.
function paneAttention(
  entry: AgentStatusEntry,
  mutedAt: number,
  now: number
): ActivityInboxKind | 'failed' | null {
  const unread = entry.sessionBoundary !== true && mutedAt < entry.stateStartedAt
  const mark = agentVerdictDisplayMark(entry)
  // A failed main agent outranks its still-live row: the list shows it as a Failed outcome.
  if (mark === 'failed') {
    return unread ? 'failed' : null
  }
  const live = freshActivityLiveAgentState(entry, now)
  if (live === 'waiting' || live === 'blocked') {
    // An agent blocked on you is a to-do: it lights the dot until it is answered, read or not.
    return 'ask'
  }
  // A cancelled or replaced turn shows as Interrupted, which the list never lists.
  if (entry.state === 'done' && mark === 'interrupted') {
    return null
  }
  if (!isHistoricalActivityState(entry.state) || !unread) {
    return null
  }
  return entry.state === 'done' ? 'outcome' : 'ask'
}

type AgentAttentionSource = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'acknowledgedAgentsByPaneKey'
  | 'activityClearedAtByPaneKey'
>

/**
 * Whether any agent waits on you or has an outcome you haven't read; stops at the first. `isBotWorkspace` says
 * whether a row's workspace is a bot's: a bot's finished turns are not listed, so they don't light the dot.
 */
export function hasActivityInboxAgentAttention(
  source: AgentAttentionSource,
  now: number,
  isBotWorkspace: ((worktreeId: string) => boolean) | null = null
): boolean {
  const { projection } = source.agentStatusByPaneKey
  for (const unsupported of Object.values(source.migrationUnsupportedByPtyId)) {
    // Only a pane with a workspace row has an Activity row to show it.
    const paneKey = migrationUnsupportedToAgentStatusEntry(unsupported)?.paneKey
    if (paneKey && projection.rowWorktree(paneKey)) {
      return true
    }
  }
  for (const [paneKey, entry] of source.agentStatusByPaneKey.entries()) {
    // Panes with no workspace row have no Activity row to clear; child workers are never listed.
    const worktreeId = projection.rowWorktree(paneKey)
    if (!worktreeId || isChildWorkerEntry(entry)) {
      continue
    }
    const mutedAt = Math.max(
      source.acknowledgedAgentsByPaneKey[paneKey] ?? 0,
      source.activityClearedAtByPaneKey?.[paneKey] ?? 0
    )
    const kind = paneAttention(entry, mutedAt, now)
    // The bot check runs only for a pane that would otherwise light the dot, so it costs nothing per heartbeat.
    if (
      kind === 'ask' ||
      kind === 'failed' ||
      (kind === 'outcome' && !isBotWorkspace?.(worktreeId))
    ) {
      return true
    }
  }
  return false
}

export type ActivityInboxBot = { bot: Bot; count: number }

// A paused bot shows nothing on its own row either; an offline host's counts are stale.
function botNeedsYou(bot: Bot): number {
  if (bot.paused || readBotHostState(bot.hostId) !== 'live') {
    return 0
  }
  return readBotItemsNeedingOwner(bot) ?? 0
}

/** Bots with tasks needing you, from counts the bot list already holds (no fetch). */
export function readActivityInboxBots(): ActivityInboxBot[] {
  const result: ActivityInboxBot[] = []
  for (const bot of readBots()) {
    const count = botNeedsYou(bot)
    if (count > 0) {
      result.push({ bot, count })
    }
  }
  return result
}

/**
 * Whether the bot's Needs you holds something new to you: an item someone else moved after the bot's seen mark
 * (the host's, which its Items tab and a paired phone move too). From what the bot list holds; no item read.
 * An older host can't say what is new, so its items stay to-dos until they're answered.
 */
export function botHasNewNeedingYou(bot: Bot): boolean {
  if (botNeedsYou(bot) === 0) {
    return false
  }
  const othersLast = readBotNeedsYouOthersLast(bot)
  return othersLast === null || othersLast > readBotItemsSeen(bot)
}

/** Whether some bot's Needs you holds something new to you. */
export function hasActivityInboxBotAttention(): boolean {
  return readBots().some(botHasNewNeedingYou)
}

/**
 * A request you can still answer: its host is live (the store keeps a disconnected host's), its bot is one this
 * window lists (as the request toast requires), and it hasn't expired. A request is a to-do, not news: it stays
 * listed, and lights the dot, until it is decided or expires.
 */
export function isLiveAccessRequest(request: HostAccessRequest, now: number = Date.now()): boolean {
  return (
    readBotHostState(request.hostId) === 'live' &&
    request.expiresAt > now &&
    readBots().some((bot) => bot.id === request.botId && bot.hostId === request.hostId)
  )
}

/** When the first of these requests expires, so a reader re-checks then; null for none. */
export function nextAccessRequestExpiry(
  requests: readonly HostAccessRequest[],
  now: number
): number | null {
  let next: number | null = null
  for (const request of requests) {
    if (request.expiresAt > now && (next === null || request.expiresAt < next)) {
      next = request.expiresAt
    }
  }
  return next
}
