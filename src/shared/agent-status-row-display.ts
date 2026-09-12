import { isFreshNonDoneAgentStatus } from './agent-status-freshness'
import type { AgentStatusState } from './agent-status-types'

/** Row states: the hook-reported statuses plus the two Orca derives when an entry goes stale. */
export type AgentRowDisplayState = AgentStatusState | 'idle' | 'unverifiable'

/**
 * The fields the decay reads. Every optional one is genuinely absent somewhere: a
 * `worktree ps` row carries none of the evidence stamps, and an older host sends no
 * `structuredHostOwned`. Absence must fall back to the ordinary window, never to "fresh".
 */
export type AgentRowDisplayInput = {
  state: AgentStatusState
  updatedAt: number
  evidenceObservedAt?: number
  mirroredEvidenceReceivedAt?: number
  restoredUnconfirmed?: boolean
  structuredHostOwned?: true
}

/**
 * Where a stale non-`done` entry decays to.
 *
 * Silence is not evidence (docs/reference/ssh-execution-boundary.md), so the destination
 * splits on the liveness Orca actually holds: a pane whose PTY is still in the live-PTY map
 * only lost its reporting stream (`unverifiable`), while a pane with no PTY has nothing
 * running behind it (`idle`). Neither ever claims the agent finished.
 *
 * `restoredUnconfirmed` rows are excluded: they are stale by construction rather than by
 * elapsed silence, and their last evidence predates a process boundary — so there is no
 * "how long since we last heard" for `unverifiable` to report.
 */
export function resolveDecayedAgentRowState(
  entry: Pick<AgentRowDisplayInput, 'state' | 'restoredUnconfirmed'>,
  hasLivePty: boolean
): 'idle' | 'unverifiable' {
  return hasLivePty && entry.state !== 'done' && entry.restoredUnconfirmed !== true
    ? 'unverifiable'
    : 'idle'
}

/**
 * The one staleness decay every agent-row reader applies: the sidebar, `worktree ps`, and
 * the mobile row list all render this state, not the raw reported one.
 *
 * `done` is an outcome, not a claim about a running process, so it never decays. Everything
 * else defers to `isFreshNonDoneAgentStatus` for the freshness question — which owns the
 * evidence clock, the host-owned exemption, and the hydrated-row rule — and this function
 * owns only where a row goes once that answer is "no".
 *
 * Callers with no live-PTY evidence (a remote reader such as mobile) leave `hasLivePty`
 * unset and get `idle`, which is the honest destination when liveness is unknown.
 */
export function resolveAgentRowDisplayState(
  row: AgentRowDisplayInput,
  now: number,
  options: { hasLivePty?: boolean; staleAfterMs?: number } = {}
): AgentRowDisplayState {
  if (row.state === 'done') {
    return 'done'
  }
  if (isFreshNonDoneAgentStatus(row, now, options.staleAfterMs)) {
    return row.state
  }
  return resolveDecayedAgentRowState(row, options.hasLivePty === true)
}
