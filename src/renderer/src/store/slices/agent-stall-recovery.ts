import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { AgentStallCause } from '../../../../shared/agent-stall-signature'
import {
  AGENT_STALL_EPISODE_RESET_MS,
  AGENT_STALL_OBSERVATION_TTL_MS,
  isLikelyRecoveryEchoObservation,
  nextAgentStallLedgerEntry,
  type AgentStallObservation,
  type AgentStallRecoveryLedgerEntry
} from '../../../../shared/agent-stall-recovery-policy'

/** Both maps are pruned on every write: observations outlive the turn that made
 *  them, and a fleet churns panes for days. */
export const AGENT_STALL_MAX_TRACKED_PANES = 200

export type AgentStallRecoverySlice = {
  agentStallByPaneKey: Record<string, AgentStallObservation>
  agentStallRecoveryLedgerByPaneKey: Record<string, AgentStallRecoveryLedgerEntry>
  observeAgentStall: (observation: AgentStallObservation) => void
  /** Drops the observation but KEEPS the ledger, so an immediate re-stall cannot loop. */
  clearAgentStallObservations: (paneKeys: readonly string[]) => void
  /** Tab and worktree teardown retire every pane under a `tabId:` prefix at once. */
  clearAgentStallsByTabPrefix: (tabIdPrefix: string) => void
  recordAgentStallRecoveryAttempt: (
    paneKey: string,
    attempt: { cause: AgentStallCause; observedAt: number; attemptedAt: number }
  ) => void
}

function withoutKeys<T>(
  source: Record<string, T>,
  shouldDrop: (key: string) => boolean
): Record<string, T> | null {
  const doomed = Object.keys(source).filter(shouldDrop)
  if (doomed.length === 0) {
    return null
  }
  const next = { ...source }
  for (const key of doomed) {
    delete next[key]
  }
  return next
}

/** Drops expired observations, then the oldest past the cap. */
function pruneObservations(
  observations: Record<string, AgentStallObservation>,
  now: number
): Record<string, AgentStallObservation> {
  const live = Object.values(observations).filter(
    (observation) => now - observation.observedAt <= AGENT_STALL_OBSERVATION_TTL_MS
  )
  if (
    live.length === Object.keys(observations).length &&
    live.length <= AGENT_STALL_MAX_TRACKED_PANES
  ) {
    return observations
  }
  return Object.fromEntries(
    live
      .sort((a, b) => b.observedAt - a.observedAt)
      .slice(0, AGENT_STALL_MAX_TRACKED_PANES)
      .map((observation) => [observation.paneKey, observation])
  )
}

/** Keeps only entries the policy can still read, so neither map depends on a
 *  pane-teardown sweep firing for every retirement path. */
function pruneLedger(
  ledger: Record<string, AgentStallRecoveryLedgerEntry>,
  observations: Record<string, AgentStallObservation>,
  now: number
): Record<string, AgentStallRecoveryLedgerEntry> {
  return (
    withoutKeys(
      ledger,
      (paneKey) =>
        !observations[paneKey] && now - ledger[paneKey].lastAttemptAt > AGENT_STALL_EPISODE_RESET_MS
    ) ?? ledger
  )
}

export const createAgentStallRecoverySlice: StateCreator<
  AppState,
  [],
  [],
  AgentStallRecoverySlice
> = (set) => ({
  agentStallByPaneKey: {},
  agentStallRecoveryLedgerByPaneKey: {},

  observeAgentStall: (observation) => {
    if (!observation.paneKey) {
      return
    }
    set((s) => {
      if (
        isLikelyRecoveryEchoObservation(
          s.agentStallRecoveryLedgerByPaneKey[observation.paneKey],
          observation.observedAt
        )
      ) {
        return s
      }
      const current = s.agentStallByPaneKey[observation.paneKey]
      // A repainting TUI re-reports the same failure; only a newer one is a write.
      if (
        current &&
        current.cause === observation.cause &&
        current.signature === observation.signature &&
        current.observedAt >= observation.observedAt
      ) {
        return s
      }
      const agentStallByPaneKey = pruneObservations(
        { ...s.agentStallByPaneKey, [observation.paneKey]: observation },
        observation.observedAt
      )
      return {
        agentStallByPaneKey,
        agentStallRecoveryLedgerByPaneKey: pruneLedger(
          s.agentStallRecoveryLedgerByPaneKey,
          agentStallByPaneKey,
          observation.observedAt
        )
      }
    })
  },

  clearAgentStallObservations: (paneKeys) => {
    if (paneKeys.length === 0) {
      return
    }
    const doomed = new Set(paneKeys)
    set((s) => {
      const agentStallByPaneKey = withoutKeys(s.agentStallByPaneKey, (key) => doomed.has(key))
      return agentStallByPaneKey ? { agentStallByPaneKey } : s
    })
  },

  clearAgentStallsByTabPrefix: (tabIdPrefix) => {
    if (!tabIdPrefix) {
      return
    }
    set((s) => buildAgentStallTabPrefixClearPatch(s, [`${tabIdPrefix}:`]) ?? s)
  },

  recordAgentStallRecoveryAttempt: (paneKey, attempt) => {
    if (!paneKey) {
      return
    }
    set((s) => ({
      agentStallRecoveryLedgerByPaneKey: pruneLedger(
        {
          ...s.agentStallRecoveryLedgerByPaneKey,
          [paneKey]: nextAgentStallLedgerEntry(
            s.agentStallRecoveryLedgerByPaneKey[paneKey],
            attempt
          )
        },
        s.agentStallByPaneKey,
        attempt.attemptedAt
      )
    }))
  }
})

/** The same clear as a patch, for the retired-tab sweep that owns its own set().
 *  Skips maps a narrow state view omits — materializing an empty one would wipe
 *  live observations once the patch reached the real store. */
export function buildAgentStallTabPrefixClearPatch(
  state: Partial<
    Pick<AgentStallRecoverySlice, 'agentStallByPaneKey' | 'agentStallRecoveryLedgerByPaneKey'>
  >,
  tabPrefixes: readonly string[]
): Partial<
  Pick<AgentStallRecoverySlice, 'agentStallByPaneKey' | 'agentStallRecoveryLedgerByPaneKey'>
> | null {
  if (tabPrefixes.length === 0) {
    return null
  }
  const matches = (paneKey: string): boolean =>
    tabPrefixes.some((prefix) => paneKey.startsWith(prefix))
  const agentStallByPaneKey = state.agentStallByPaneKey
    ? withoutKeys(state.agentStallByPaneKey, matches)
    : null
  const agentStallRecoveryLedgerByPaneKey = state.agentStallRecoveryLedgerByPaneKey
    ? withoutKeys(state.agentStallRecoveryLedgerByPaneKey, matches)
    : null
  if (!agentStallByPaneKey && !agentStallRecoveryLedgerByPaneKey) {
    return null
  }
  return {
    ...(agentStallByPaneKey ? { agentStallByPaneKey } : {}),
    ...(agentStallRecoveryLedgerByPaneKey ? { agentStallRecoveryLedgerByPaneKey } : {})
  }
}
