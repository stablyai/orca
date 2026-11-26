// Activity as an inbox (app rail on): it lists what is addressed to you, requests only you can move and
// outcomes you haven't read, never work that is merely running. Live progress stays on workspace cards.
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { Bot } from '../../../../../shared/bot-types'
import { migrationUnsupportedToAgentStatusEntry } from '../../../../../shared/agent-status/presentation/migration-unsupported-agent-entry'
import { readBotHostState, readBotItemsNeedingOwner, readBots } from '@/lib/bot-catalog-snapshot'
import type { HostAccessRequest } from '@/lib/bot-access-requests'
import {
  freshActivityLiveAgentState,
  isHistoricalActivityState
} from '../events/activity-event-state'
import { activityThreadStatusId } from '../threads/activity-thread-presentation'
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

// Only the current turn counts, so the dot never lights for a row the list leaves out.
function hasUnreadOutcome(entry: AgentStatusEntry, mutedAt: number): boolean {
  return (
    isHistoricalActivityState(entry.state) &&
    entry.sessionBoundary !== true &&
    mutedAt < entry.stateStartedAt
  )
}

type AgentAttentionSource = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'acknowledgedAgentsByPaneKey'
  | 'activityClearedAtByPaneKey'
>

/** Whether any agent waits on you or has an outcome you haven't read; stops at the first. */
export function hasActivityInboxAgentAttention(source: AgentAttentionSource, now: number): boolean {
  for (const unsupported of Object.values(source.migrationUnsupportedByPtyId)) {
    if (migrationUnsupportedToAgentStatusEntry(unsupported)) {
      return true
    }
  }
  const { projection } = source.agentStatusByPaneKey
  for (const [paneKey, entry] of source.agentStatusByPaneKey.entries()) {
    // Panes with no workspace row have no Activity row to clear; child workers are never listed.
    if (!projection.rowWorktree(paneKey) || isChildWorkerEntry(entry)) {
      continue
    }
    const live = freshActivityLiveAgentState(entry, now)
    if (live === 'waiting' || live === 'blocked') {
      return true
    }
    const mutedAt = Math.max(
      source.acknowledgedAgentsByPaneKey[paneKey] ?? 0,
      source.activityClearedAtByPaneKey?.[paneKey] ?? 0
    )
    if (hasUnreadOutcome(entry, mutedAt)) {
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

export function hasActivityInboxBotAttention(): boolean {
  return readBots().some((bot) => botNeedsYou(bot) > 0)
}

/** The store keeps a disconnected host's requests; only a live host can answer one. */
export function isLiveAccessRequest(request: HostAccessRequest): boolean {
  return readBotHostState(request.hostId) === 'live'
}
