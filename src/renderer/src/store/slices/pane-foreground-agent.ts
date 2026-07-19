import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/types'

// Why: attribution consumers (sidebar rows, worktree ring) must not trust
// process identity forever — an exited agent's entry could otherwise fake a
// working state. 30s sits above the completion coordinator's slowest cadences
// (3s hidden backstop, 15s no-evidence poll), which re-arm the observation.
export const PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS = 30_000
// Why: active-tier inspections land every ~750ms; re-stamping each one would
// churn the store, so freshness bumps are quantized well below the TTL.
const OBSERVATION_REFRESH_QUANTUM_MS = 5_000

export type PaneForegroundAgentEntry = {
  /** Recognized agent process in the pane's foreground; null when unknown. */
  agent: TuiAgent | null
  /** True only when fresh provider evidence is safe for input-byte routing. */
  routingTrusted?: boolean
  /** True after exit/input evidence revokes routing until provider confirmation. */
  routingRevoked?: boolean
  /** True once the foreground is proven back at the shell (OSC 133;D) —
   *  process-grade launched-agent exit evidence, independent of titles. */
  shellForeground: boolean
  /** When this evidence was recorded; attribution consumers gate on the TTL. */
  observedAt?: number
  /** PTY the evidence was read from, when the publisher knows it. */
  ptyId?: string
}

/**
 * Process-table identity for local panes, read at OSC 133 command boundaries
 * (see pane-foreground-agent-tracker). Sits below hook rows in the tab-icon
 * resolution; covers agents that emit neither hooks nor titles.
 */
export type PaneForegroundAgentSlice = {
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
  setPaneForegroundAgent: (paneKey: string, entry: PaneForegroundAgentEntry) => void
  /** Freshness bump from the completion coordinator's existing inspections —
   *  identity only, never routing trust; a differing identity is ignored so
   *  the tracker keeps sole ownership of identity changes. */
  refreshPaneForegroundAgentObservation: (paneKey: string, agent: TuiAgent) => void
  clearPaneForegroundAgent: (paneKey: string) => void
  /** Wholesale teardown sweeps (tab close, worktree sleep/remove) retire pane
   *  keys without per-pane close events — clear their entries too. */
  clearPaneForegroundAgentByTabPrefix: (tabIdPrefix: string) => void
  clearPaneForegroundAgentByWorktree: (worktreeId: string) => void
}

/**
 * Attribution-grade read of a pane's process identity: the agent counts only
 * while the evidence is fresh (TTL) and the pane still has a live PTY — at the
 * finest liveness granularity the caller can supply.
 */
export function resolveFreshPaneForegroundAgent(
  entry: PaneForegroundAgentEntry | undefined,
  args: { now: number; paneBoundPtyId?: string; liveTabPtyIds?: readonly string[] }
): TuiAgent | null {
  if (!entry?.agent || entry.observedAt === undefined) {
    return null
  }
  if (args.now - entry.observedAt > PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS) {
    return null
  }
  if (args.paneBoundPtyId !== undefined) {
    return entry.ptyId === undefined || entry.ptyId === args.paneBoundPtyId ? entry.agent : null
  }
  if (entry.ptyId !== undefined) {
    return args.liveTabPtyIds?.includes(entry.ptyId) === true ? entry.agent : null
  }
  return (args.liveTabPtyIds?.length ?? 0) > 0 ? entry.agent : null
}

export const createPaneForegroundAgentSlice: StateCreator<
  AppState,
  [],
  [],
  PaneForegroundAgentSlice
> = (set) => ({
  paneForegroundAgentByPaneKey: {},
  setPaneForegroundAgent: (paneKey, entry) => {
    set((s) => {
      const now = Date.now()
      const current = s.paneForegroundAgentByPaneKey[paneKey]
      if (
        current &&
        current.agent === entry.agent &&
        current.routingTrusted === entry.routingTrusted &&
current.routingRevoked === entry.routingRevoked &&
        current.shellForeground === entry.shellForeground &&
        current.ptyId === entry.ptyId
      ) {
        // Why: an identical re-publish is still fresh evidence; bump the
        // observation quantized so repeated confirmations don't churn the store.
        if (
          current.observedAt !== undefined &&
          now - current.observedAt < OBSERVATION_REFRESH_QUANTUM_MS
        ) {
          return s
        }
        return {
          paneForegroundAgentByPaneKey: {
            ...s.paneForegroundAgentByPaneKey,
            [paneKey]: { ...current, observedAt: now }
          }
        }
      }
      return {
        paneForegroundAgentByPaneKey: {
          ...s.paneForegroundAgentByPaneKey,
          // Why: stamp centrally so every publisher gets TTL-gated evidence.
          [paneKey]: { ...entry, observedAt: entry.observedAt ?? now }
        }
      }
    })
  },
  refreshPaneForegroundAgentObservation: (paneKey, agent) => {
    set((s) => {
      const now = Date.now()
      const current = s.paneForegroundAgentByPaneKey[paneKey]
      if (current) {
        if (current.agent !== agent) {
          return s
        }
        if (
          current.observedAt !== undefined &&
          now - current.observedAt < OBSERVATION_REFRESH_QUANTUM_MS
        ) {
          return s
        }
        return {
          paneForegroundAgentByPaneKey: {
            ...s.paneForegroundAgentByPaneKey,
            [paneKey]: { ...current, observedAt: now }
          }
        }
      }
      // Why: coordinator inspections also cover panes whose tracker read raced
      // or whose shell emits no OSC 133 — identity evidence only, no routing.
      return {
        paneForegroundAgentByPaneKey: {
          ...s.paneForegroundAgentByPaneKey,
          [paneKey]: { agent, shellForeground: false, observedAt: now }
        }
      }
    })
  },
  clearPaneForegroundAgent: (paneKey) => {
    set((s) => {
      if (!(paneKey in s.paneForegroundAgentByPaneKey)) {
        return s
      }
      const next = { ...s.paneForegroundAgentByPaneKey }
      delete next[paneKey]
      return { paneForegroundAgentByPaneKey: next }
    })
  },
  clearPaneForegroundAgentByTabPrefix: (tabIdPrefix) => {
    set((s) => clearEntriesByTabPrefixes(s.paneForegroundAgentByPaneKey, [`${tabIdPrefix}:`]) ?? s)
  },
  clearPaneForegroundAgentByWorktree: (worktreeId) => {
    // Why: entries carry no worktreeId, so this must run while the worktree's
    // tabs are still in tabsByWorktree (removeWorktree prunes them only after
    // awaiting terminal teardown).
    set((s) => {
      const prefixes = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
      return clearEntriesByTabPrefixes(s.paneForegroundAgentByPaneKey, prefixes) ?? s
    })
  }
})

function clearEntriesByTabPrefixes(
  entries: Record<string, PaneForegroundAgentEntry>,
  tabPrefixes: string[]
): Pick<PaneForegroundAgentSlice, 'paneForegroundAgentByPaneKey'> | null {
  if (tabPrefixes.length === 0) {
    return null
  }
  const staleKeys = Object.keys(entries).filter((paneKey) =>
    tabPrefixes.some((prefix) => paneKey.startsWith(prefix))
  )
  if (staleKeys.length === 0) {
    return null
  }
  const next = { ...entries }
  for (const paneKey of staleKeys) {
    delete next[paneKey]
  }
  return { paneForegroundAgentByPaneKey: next }
}
