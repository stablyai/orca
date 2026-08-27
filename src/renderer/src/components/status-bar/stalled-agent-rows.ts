/**
 * Turns the stall map into rows the status-bar popover can render and act on,
 * one per pane, so the user can continue a single agent instead of the fleet.
 */

import type { AgentStallCause } from '../../../../shared/agent-stall-signature'
import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type {
  AgentStallObservation,
  AgentStallRecoveryLedgerEntry
} from '../../../../shared/agent-stall-recovery-policy'
import { agentStallRateLimitResetAt } from '../../../../shared/agent-stall-rate-limit-provider'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

/** How long a continued agent stays listed. Recovery clears the stall the
 *  instant it succeeds, so without this the status bar blinks for a few seconds
 *  and the user only ever sees agents reviving by themselves. */
export const AGENT_STALL_RECENTLY_CONTINUED_MS = 2 * 60 * 1000

export type StalledAgentRow = {
  paneKey: string
  worktreeId: string
  worktreeName: string
  agentType: AgentType | null
  cause: AgentStallCause
  /** The matched failure text, for the row's second line. */
  signature: string
  observedAt: number
  /** True while continuing cannot work yet — a provider window that has not
   *  reopened. Kept separate from `resetAt` because "blocked, reset unknown"
   *  and "not blocked" are different answers. */
  blocked: boolean
  /** When the window reopens, when Orca knows it. */
  resetAt: number | null
  /** Set when this agent was already continued — the row is history, not a
   *  pane still waiting. Null while it is genuinely stalled. */
  continuedAt: number | null
}

export type StalledAgentRowsState = {
  agentStallByPaneKey: Record<string, AgentStallObservation | undefined>
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
  agentStallRecoveryLedgerByPaneKey: Record<string, AgentStallRecoveryLedgerEntry | undefined>
  tabsByWorktree: Record<string, readonly { id: string }[] | undefined>
  worktreesByRepo: Record<string, readonly { id: string; name?: string }[] | undefined>
  rateLimits?: RateLimitState
}

function buildWorktreeNames(state: StalledAgentRowsState): {
  byTabId: Map<string, string>
  nameById: Map<string, string>
} {
  const byTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs ?? []) {
      byTabId.set(tab.id, worktreeId)
    }
  }
  const nameById = new Map<string, string>()
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    for (const worktree of worktrees ?? []) {
      if (worktree.name) {
        nameById.set(worktree.id, worktree.name)
      }
    }
  }
  return { byTabId, nameById }
}

/** Longest-stalled first: that is the agent that has been waiting on the user.
 *  Agents already continued sort after the ones still waiting. */
export function selectStalledAgentRows(
  state: StalledAgentRowsState,
  now: number
): StalledAgentRow[] {
  const { byTabId, nameById } = buildWorktreeNames(state)

  const buildRow = (
    paneKey: string,
    cause: AgentStallCause,
    signature: string,
    observedAt: number,
    continuedAt: number | null
  ): StalledAgentRow => {
    const parsed = parsePaneKey(paneKey)
    const worktreeId = parsed ? (byTabId.get(parsed.tabId) ?? '') : ''
    const agentType = state.agentStatusByPaneKey[paneKey]?.agentType ?? null
    const resetAt =
      cause === 'rate-limit' ? agentStallRateLimitResetAt(state.rateLimits, agentType) : null
    return {
      paneKey,
      worktreeId,
      // Falls back to the id so a row is never nameless while a workspace is
      // still loading its listing.
      worktreeName: nameById.get(worktreeId) ?? worktreeId,
      agentType,
      cause,
      signature,
      observedAt,
      // A rate-limit row with no known reset stays blocked — Orca just cannot
      // say for how long, and nudging early spends the turn on a refusal.
      blocked:
        continuedAt === null && cause === 'rate-limit' && (resetAt === null || now < resetAt),
      resetAt,
      continuedAt
    }
  }

  const rows = Object.values(state.agentStallByPaneKey)
    .filter((observation): observation is AgentStallObservation => Boolean(observation))
    .map((observation) =>
      buildRow(
        observation.paneKey,
        observation.cause,
        observation.signature,
        observation.observedAt,
        null
      )
    )

  // Recovery deletes the stall the moment it lands, so what just happened is
  // only legible from the ledger it deliberately keeps.
  for (const [paneKey, entry] of Object.entries(state.agentStallRecoveryLedgerByPaneKey)) {
    if (!entry || state.agentStallByPaneKey[paneKey]) {
      continue
    }
    if (now - entry.lastAttemptAt > AGENT_STALL_RECENTLY_CONTINUED_MS) {
      continue
    }
    rows.push(buildRow(paneKey, entry.cause, '', entry.lastAttemptAt, entry.lastAttemptAt))
  }

  return rows.sort(
    (a, b) =>
      Number(a.continuedAt !== null) - Number(b.continuedAt !== null) ||
      a.observedAt - b.observedAt ||
      a.paneKey.localeCompare(b.paneKey)
  )
}

/** Agents still waiting on the user, as opposed to ones already continued. */
export function stalledAgentRowsPending(rows: readonly StalledAgentRow[]): StalledAgentRow[] {
  return rows.filter((row) => row.continuedAt === null)
}

export function stalledAgentRowsCanContinue(rows: readonly StalledAgentRow[]): boolean {
  return rows.some((row) => row.continuedAt === null && !row.blocked)
}
