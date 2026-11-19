// What a bot is doing now: the one owner of what needs the owner and what is working, for its panel
// header, Activity tab, panel toggle and the Activity list's sections alike.
import type { AgentDotState } from '../agent-dot-state'
import type { AgentStatusState } from '../agent-status/contracts/agent-status-types'
import type { BotActivity, BotSessionActivityRow } from './bot-activity-model'
import type { BotAutomationRow } from './bot-automation-rows'

/** Something only the owner can move. Up next is the bot's suggestions, never one of these. */
export type BotNeed<Connector = never, Request = never> =
  /** The Home chat asks the owner something. */
  | { kind: 'chat'; key: string }
  /** A side chat with the bot asks the owner something. */
  | { kind: 'side-chat'; key: string; sessionId: string; title: string }
  /** A worker, thread or run chat waits on an approval or an answer. A failed run is never one:
   *  its automation's row says so. */
  | { kind: 'session'; key: string; row: BotSessionActivityRow }
  /** A connector the owner must sign in to or fix, as its own state says now. */
  | { kind: 'connector'; key: string; connector: Connector }
  /** Someone asked for access to the bot. */
  | { kind: 'access'; key: string; request: Request }

export type BotNow<Connector = never, Request = never> = {
  needs: BotNeed<Connector, Request>[]
  /**
   * Automations whose newest run stopped for a sign-in, listed with the connector needs that likely
   * stopped them and not counted on their own: signing in is one action. Runs don't name the
   * connector, so with no connector needing the owner they are history, not a need.
   */
  stoppedForSignIn: BotAutomationRow[]
  needsYou: number
  /** Still open and not waiting on the owner: the Home chat replying, or a worker, thread or run. */
  working: number
}

export type BotNowInput<Connector, Request> = {
  /** `automations` lists every automation, so a failed run never scrolls out like a capped feed row. */
  activity: Pick<BotActivity, 'workers' | 'inProgress' | 'automations'>
  /** The Home chat's own status; Activity lists only the work around it. */
  chatState: AgentStatusState | null
  /** The bot's connectors that need the owner. */
  connectors?: readonly (Connector & { key: string })[]
  accessRequests?: readonly (Request & { requestId: string })[]
  /** Side chats waiting on the owner; threads and run chats come through `activity`. */
  waitingSideChats?: readonly { sessionId: string; title: string }[]
}

function waitsOnOwner(dot: AgentDotState | null): boolean {
  return dot === 'blocked' || dot === 'waiting' || dot === 'permission'
}

const CHAT_KEY = 'chat'

export function botNow<Connector = never, Request = never>({
  activity,
  chatState,
  connectors = [],
  accessRequests = [],
  waitingSideChats = []
}: BotNowInput<Connector, Request>): BotNow<Connector, Request> {
  const live = [...activity.workers, ...activity.inProgress]
  const needs: BotNeed<Connector, Request>[] = []
  let working = 0
  if (chatState === 'blocked' || chatState === 'waiting') {
    needs.push({ kind: 'chat', key: CHAT_KEY })
  } else if (chatState === 'working') {
    working += 1
  }
  for (const chat of waitingSideChats) {
    needs.push({ kind: 'side-chat', key: `side-chat:${chat.sessionId}`, ...chat })
  }
  for (const row of live) {
    if (waitsOnOwner(row.dot)) {
      needs.push({ kind: 'session', key: row.key, row })
    } else {
      working += 1
    }
  }
  for (const connector of connectors) {
    needs.push({ kind: 'connector', key: `connector:${connector.key}`, connector })
  }
  for (const request of accessRequests) {
    needs.push({ kind: 'access', key: `access:${request.requestId}`, request })
  }
  const stoppedForSignIn =
    connectors.length > 0 ? activity.automations.filter((row) => row.needsSignIn === true) : []
  return { needs, stoppedForSignIn, needsYou: needs.length, working }
}

/**
 * The one Needs you count: the Items tab badge, the panel toggle, the bot line's count and the phone
 * tab read it unfiltered; the group heading reads it for the rows a filter shows. Orca's asks (never
 * runs a sign-in stopped, which are listed beside them as context) plus Needs you items that aren't stale.
 */
export function botNeedsYouCount(asks: number, items: number): number {
  return asks + items
}
