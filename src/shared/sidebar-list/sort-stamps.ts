import { agentPhaseTransition, type AgentPhase, type AgentTransition } from '../agent-transitions'

/** Owning hosts stamp events; every client sorts without a clock. recentAt persists in lastActivityAt. */

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
  /** A pane’s transition plus every pane’s state afterwards. */
  | {
      kind: 'agent'
      from: AgentPhase
      to: AgentPhase
      transition: AgentTransition | null
      panes: readonly AgentPaneState[]
    }
  | { kind: 'bell' }
  | { kind: 'terminal-started' }

/** Done holds until prompt/exit with no fade. Resuming approval stays in the same turn and retains its request time. */
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

/** Most demanding pane wins; unread Done outranks Working, read Done does not. Use the tier’s latest time.
 * Read Done alone remains Done on disk but readers show Rest. */
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

/** Pure host-time event classification; use post-event unread state (absent lets Done outrank Working).
 * Prompts/finishes/input requests stamp recentAt; tier changes apply immediately; null means unchanged. */
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

/** Finishes/failures/input requests/bells mark unseen news; session-boundary Done changes tier without raising unread. */
export function isUnreadNews(event: SortStampEvent): boolean {
  if (event.kind !== 'agent') {
    return event.kind === 'bell'
  }
  return event.transition !== null && event.transition !== 'prompt-submitted'
}
