import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type PaneForegroundAgentEntry = {
  /** Recognized agent process in the pane's foreground; null when unknown. */
  agent: TuiAgent | null
  /** True only when fresh provider evidence is safe for input-byte routing. */
  routingTrusted?: boolean
  /** True after exit/input evidence revokes routing until provider confirmation. */
  routingRevoked?: boolean
  /** True while previously trusted routing awaits provider revalidation. Retains
   *  Shift+Enter byte capability only — the Ctrl+Enter resolver deliberately does
   *  not read it, because its fallback is a plain CR that submits either way. */
  routingConfirmationPending?: boolean
  /** True once the foreground is proven back at the shell (OSC 133;D) —
   *  process-grade launched-agent exit evidence, independent of titles. */
  shellForeground: boolean
}

/**
 * Process-table identity for local panes, read at OSC 133 command boundaries
 * (see pane-foreground-agent-tracker). Sits below hook rows in the tab-icon
 * resolution; covers agents that emit neither hooks nor titles.
 */
export type PaneForegroundAgentSlice = {
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
  setPaneForegroundAgent: (paneKey: string, entry: PaneForegroundAgentEntry) => void
  clearPaneForegroundAgent: (paneKey: string) => void
  /** Wholesale teardown sweeps (tab close, worktree sleep/remove) retire pane
   *  keys without per-pane close events — clear their entries too. */
  clearPaneForegroundAgentByTabPrefix: (tabIdPrefix: string) => void
  clearPaneForegroundAgentByWorktree: (worktreeId: string) => void
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
      const current = s.paneForegroundAgentByPaneKey[paneKey]
      if (
        current &&
        current.agent === entry.agent &&
        current.routingTrusted === entry.routingTrusted &&
        current.routingRevoked === entry.routingRevoked &&
        current.routingConfirmationPending === entry.routingConfirmationPending &&
        current.shellForeground === entry.shellForeground
      ) {
        return s
      }
      return {
        paneForegroundAgentByPaneKey: { ...s.paneForegroundAgentByPaneKey, [paneKey]: entry }
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
    set(
      (s) =>
        buildPaneForegroundAgentTabPrefixClearPatch(s.paneForegroundAgentByPaneKey, [
          `${tabIdPrefix}:`
        ]) ?? s
    )
  },
  clearPaneForegroundAgentByWorktree: (worktreeId) => {
    // Why: entries carry no worktreeId, so this must run while the worktree's
    // tabs are still in tabsByWorktree (removeWorktree prunes them only after
    // awaiting terminal teardown).
    set((s) => {
      const prefixes = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
      return (
        buildPaneForegroundAgentTabPrefixClearPatch(s.paneForegroundAgentByPaneKey, prefixes) ?? s
      )
    })
  }
})

export function buildPaneForegroundAgentTabPrefixClearPatch(
  entries: Record<string, PaneForegroundAgentEntry>,
  tabPrefixes: readonly string[]
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
