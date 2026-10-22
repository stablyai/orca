import { agentPhaseTransition, type AgentPhase, type AgentTransition } from '../agent-transitions'

/**
 * Sort stamps the host that owns a workspace writes on its record when something happens there.
 * Every client sorts by them; none keeps a clock. `recentAt` is stored in `lastActivityAt`.
 */

/** Smart's tiers, most demanding first. No tier means Rest, ordered by `recentAt`. */
export const SMART_TIERS = ['needs-you', 'done', 'working'] as const satisfies readonly AgentPhase[]
export type SmartTier = (typeof SMART_TIERS)[number]

export function isSmartTier(value: unknown): value is SmartTier {
  return SMART_TIERS.some((tier) => tier === value)
}

/** The tier fields on a worktree or folder workspace record; both absent together means Rest. */
export type SmartStampFields = { smartTier?: SmartTier; smartAt?: number }

export type SortStamps = { recentAt: number } & SmartStampFields

/** One agent pane's place in Smart, and when it took it. */
export type AgentPaneState = { phase: AgentPhase; at: number }

/** A `recentAt` stamp this soon after the previous one is dropped; the first one wins. */
export const RECENT_STAMP_THROTTLE_MS = 10_000

export type SortStampEvent =
  /** One pane moved; `transition` is the detector's news in it, `panes` every pane of the
   *  workspace afterwards. */
  | {
      kind: 'agent'
      from: AgentPhase
      to: AgentPhase
      transition: AgentTransition | null
      panes: readonly AgentPaneState[]
    }
  | { kind: 'bell' }
  | { kind: 'terminal-started' }

/**
 * A pane's state on entering `phase` at `now`, from `previous`. Done stays until the next prompt or
 * the agent exits (owner decision Q1: no fade). Resuming after an approval is the same turn, so it
 * keeps the time it asked.
 */
export function enterAgentPaneState(
  previous: AgentPaneState,
  phase: AgentPhase,
  now: number
): AgentPaneState {
  if (phase === previous.phase) {
    return previous
  }
  return { phase, at: previous.phase === 'needs-you' && phase === 'working' ? previous.at : now }
}

export const REST_PANE: AgentPaneState = { phase: 'rest', at: 0 }

/** A read Done ranks below Working: the user has seen that finish, another pane still runs. */
const READ_TIER_ORDER = ['needs-you', 'working', 'done'] as const satisfies readonly SmartTier[]

/**
 * The workspace's tier is its most demanding pane, Done counting over Working only while unread;
 * its time is that tier's latest entry. A read Done alone stays Done, which readers show as Rest.
 */
export function workspaceSmartStamp(
  panes: readonly AgentPaneState[],
  isUnread = true
): SmartStampFields {
  const tier = (isUnread ? SMART_TIERS : READ_TIER_ORDER).find((candidate) =>
    panes.some((pane) => pane.phase === candidate)
  )
  if (!tier) {
    return {}
  }
  let smartAt = 0
  for (const pane of panes) {
    if (pane.phase === tier && pane.at > smartAt) {
      smartAt = pane.at
    }
  }
  return { smartTier: tier, smartAt }
}

/**
 * The stamps after `event`, or null when nothing changes. Pure: `now` is the host's time of the
 * event; `isUnread` the workspace's flag after it (unset: Done outranks Working). Prompts,
 * finishes and requests for input stamp `recentAt`; tier changes apply at once.
 */
export function classifySortStampEvent(
  current: SortStamps,
  event: SortStampEvent,
  now: number,
  isUnread = true
): SortStamps | null {
  const stampsRecent = event.kind !== 'agent' || agentPhaseTransition(event.from, event.to) !== null
  const recentAt =
    stampsRecent && now - current.recentAt >= RECENT_STAMP_THROTTLE_MS ? now : current.recentAt
  const smart =
    event.kind === 'agent'
      ? workspaceSmartStamp(event.panes, isUnread)
      : { smartTier: current.smartTier, smartAt: current.smartAt }
  if (
    recentAt === current.recentAt &&
    smart.smartTier === current.smartTier &&
    smart.smartAt === current.smartAt
  ) {
    return null
  }
  return {
    recentAt,
    ...(smart.smartTier !== undefined ? { smartTier: smart.smartTier, smartAt: smart.smartAt } : {})
  }
}

/**
 * A finish (or failure), a request for input or a bell: news that flags the workspace for whoever
 * isn't looking. A session boundary's done moves the tier but is no news.
 */
export function isUnreadNews(event: SortStampEvent): boolean {
  if (event.kind !== 'agent') {
    return event.kind === 'bell'
  }
  return event.transition !== null && event.transition !== 'prompt-submitted'
}
