import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TerminalAgent } from '../../../../shared/terminal-agent'

/** 'launch-record': the daemon's launch identity on reattach, which can outlive the process. */
export type PaneForegroundAgentEvidence = 'process-read' | 'launch-record'

export type PaneForegroundAgentEntry = {
  /** Recognized agent process in the pane's foreground; null when unknown. */
  agent: TerminalAgent | null
  agentName?: string
  agentPid?: number
  permissionMode?: string
  /** Where `agent` came from. Only 'process-read' is a live read; absent counts as unconfirmed,
   *  so a writer that omits it cannot make a sidebar row look process-backed. */
  agentEvidence?: PaneForegroundAgentEvidence
  /** True only when fresh provider evidence is safe for input-byte routing. */
  routingTrusted?: boolean
  /** True after exit/input evidence revokes routing until provider confirmation. */
  routingRevoked?: boolean
  /** Pending revalidation retains only Shift+Enter bytes; Ctrl+Enter intentionally uses plain CR fallback that submits either way. */
  routingConfirmationPending?: boolean
  /** True once the foreground is proven back at the shell (OSC 133;D) —
   *  process-grade launched-agent exit evidence, independent of titles. */
  shellForeground: boolean
}

/** Local process-table evidence at OSC 133 boundaries supports agents without hooks/titles, below hook rows in icon priority. */
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
  /** Skips the update when every field, including peer metadata, is unchanged. */
  setPaneForegroundAgent: (paneKey, entry) => {
    set((s) => {
      const current = s.paneForegroundAgentByPaneKey[paneKey]
      if (
        current &&
        current.agent === entry.agent &&
        current.agentName === entry.agentName &&
        current.agentPid === entry.agentPid &&
        current.permissionMode === entry.permissionMode &&
        current.agentEvidence === entry.agentEvidence &&
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
    // Entries lack worktree IDs; sweep while tabs still exist, before removeWorktree prunes after terminal teardown.
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
