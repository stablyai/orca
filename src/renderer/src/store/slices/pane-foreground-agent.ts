import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { isShellProcess } from '../../../../shared/shell-process-detection'
import type { TuiAgent } from '../../../../shared/types'

// Why: expire identity after the coordinator's slowest 15s cadence so exited
// agents cannot leave false working state indefinitely.
export const PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS = 30_000
// Why: active-tier inspections land every ~750ms; re-stamping each one would
// churn the store, so freshness bumps are quantized well below the TTL.
const OBSERVATION_REFRESH_QUANTUM_MS = 5_000

export type PaneForegroundAgentEntry = {
  /** Recognized agent process in the pane's foreground; null when unknown. */
  agent: TuiAgent | null
  /** Raw process-table basename behind this evidence, when a read produced one.
   *  Lets a consumer render a neutral live identity for an unrecognized (fork)
   *  agent instead of collapsing it to "bare shell". */
  rawProcessName?: string | null
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
  /** Refresh identity from an existing inspection, never routing trust. */
  refreshPaneForegroundAgentObservation: (paneKey: string, agent: TuiAgent, ptyId?: string) => void
  clearPaneForegroundAgent: (paneKey: string) => void
  /** Wholesale teardown sweeps (tab close, worktree sleep/remove) retire pane
   *  keys without per-pane close events — clear their entries too. */
  clearPaneForegroundAgentByTabPrefix: (tabIdPrefix: string) => void
  clearPaneForegroundAgentByWorktree: (worktreeId: string) => void
}

type PaneForegroundLivenessArgs = {
  now: number
  paneBoundPtyId?: string
  liveTabPtyIds?: readonly string[]
}

/**
 * The TTL + PTY-binding gate shared by every fresh-evidence read: evidence
 * counts only while it is within the TTL and still bound to a live PTY, at the
 * finest liveness granularity the caller can supply.
 */
function isFreshPaneForegroundEvidence(
  entry: PaneForegroundAgentEntry,
  args: PaneForegroundLivenessArgs
): boolean {
  if (entry.observedAt === undefined) {
    return false
  }
  if (args.now - entry.observedAt > PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS) {
    return false
  }
  if (args.paneBoundPtyId !== undefined) {
    return entry.ptyId === undefined || entry.ptyId === args.paneBoundPtyId
  }
  if (entry.ptyId !== undefined) {
    return args.liveTabPtyIds?.includes(entry.ptyId) === true
  }
  return (args.liveTabPtyIds?.length ?? 0) > 0
}

/**
 * Attribution-grade read of a pane's process identity: the agent counts only
 * while the evidence is fresh (TTL) and the pane still has a live PTY — at the
 * finest liveness granularity the caller can supply.
 */
export function resolveFreshPaneForegroundAgent(
  entry: PaneForegroundAgentEntry | undefined,
  args: PaneForegroundLivenessArgs
): TuiAgent | null {
  if (!entry?.agent) {
    return null
  }
  return isFreshPaneForegroundEvidence(entry, args) ? entry.agent : null
}

/**
 * Fresh unknown-live evidence: a live, non-shell foreground process with no
 * recognized engine. Gated by the same TTL/PTY binding as the agent read so a
 * dead fork process cannot keep painting the tab after the pane moved on.
 */
export function resolveFreshPaneForegroundRawProcess(
  entry: PaneForegroundAgentEntry | undefined,
  args: PaneForegroundLivenessArgs
): string | null {
  if (
    !entry ||
    entry.agent !== null ||
    !entry.rawProcessName ||
    isShellProcess(entry.rawProcessName)
  ) {
    return null
  }
  return isFreshPaneForegroundEvidence(entry, args) ? entry.rawProcessName : null
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
        current.rawProcessName === entry.rawProcessName &&
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
  refreshPaneForegroundAgentObservation: (paneKey, agent, ptyId) => {
    set((s) => {
      const now = Date.now()
      const current = s.paneForegroundAgentByPaneKey[paneKey]
      if (current) {
        if (current.agent !== agent) {
          return s
        }
        if (ptyId !== undefined && current.ptyId === undefined) {
          return {
            paneForegroundAgentByPaneKey: {
              ...s.paneForegroundAgentByPaneKey,
              [paneKey]: { ...current, observedAt: now, ptyId }
            }
          }
        }
        // Why: evidence bound to a previous PTY must not be kept fresh across
        // a respawn — rebind it as identity-only evidence of the inspected PTY.
        if (ptyId !== undefined && current.ptyId !== undefined && current.ptyId !== ptyId) {
          return {
            paneForegroundAgentByPaneKey: {
              ...s.paneForegroundAgentByPaneKey,
              [paneKey]: { agent, shellForeground: false, observedAt: now, ptyId }
            }
          }
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
          [paneKey]: {
            agent,
            shellForeground: false,
            observedAt: now,
            ...(ptyId !== undefined ? { ptyId } : {})
          }
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
