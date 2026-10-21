import type { RetainedAgentEntry } from './agent-status-contract'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import { mergeCurrentOrchestrationContext } from './agent-status-orchestration-context'
import { capRetainedAgents } from './agent-status-capacity-eviction'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

// Why: a retained row survives only as long as the tab/leaf it reports on is
// still real. `undefined` (tab absent from the map) and a Set not containing
// the leaf both mean "gone"; `null` means the tab's layout has not hydrated
// yet, so leaf absence is inconclusive and must not evict the row.
function retainedRowIsOrphaned(
  retained: RetainedAgentEntry,
  liveLeafIdsByTabId: ReadonlyMap<string, ReadonlySet<string> | null>
): boolean {
  const parsed = parsePaneKey(retained.entry.paneKey)
  const tabId = parsed?.tabId ?? retained.tab.id
  if (!liveLeafIdsByTabId.has(tabId)) {
    return true
  }
  if (!parsed) {
    // Legacy numeric pane keys resolve to a stable leaf elsewhere; absent
    // that resolution, tab existence (checked above) is the only evidence.
    return false
  }
  const liveLeafIds = liveLeafIdsByTabId.get(tabId)
  return liveLeafIds !== null && liveLeafIds !== undefined && !liveLeafIds.has(parsed.leafId)
}

/** Builds the retain/dismiss/prune action set for the agent-status slice. */
export function createAgentStatusRetentionActions(
  runtime: AgentStatusRuntime
): Pick<
  AgentStatusSlice,
  | 'retainAgents'
  | 'dismissRetainedAgent'
  | 'dismissRetainedAgents'
  | 'dismissRetainedAgentsByWorktree'
  | 'pruneRetainedAgents'
  | 'clearRetentionSuppressedPaneKeys'
> {
  const { set } = runtime
  return {
    retainAgents: (entries: RetainedAgentEntry[]) => {
      if (entries.length === 0) {
        return
      }
      set((s) => {
        let changed = false
        for (const retained of entries) {
          if (s.retainedAgentsByPaneKey[retained.entry.paneKey] !== retained) {
            changed = true
            break
          }
        }
        if (!changed) {
          return s
        }
        const next = { ...s.retainedAgentsByPaneKey }
        for (const retained of entries) {
          const runtimeOrchestration = s.runtimeAgentOrchestrationByPaneKey[retained.entry.paneKey]
          const mergedOrchestration = runtimeOrchestration
            ? mergeCurrentOrchestrationContext(retained.entry.orchestration, runtimeOrchestration)
            : retained.entry.orchestration
          const entry =
            mergedOrchestration !== retained.entry.orchestration
              ? { ...retained.entry, orchestration: mergedOrchestration }
              : retained.entry
          next[retained.entry.paneKey] =
            entry === retained.entry ? retained : { ...retained, entry }
        }
        return { retainedAgentsByPaneKey: capRetainedAgents(next) }
      })
    },

    dismissRetainedAgent: (paneKey) => {
      set((s) => {
        if (!(paneKey in s.retainedAgentsByPaneKey)) {
          return s
        }
        const next = { ...s.retainedAgentsByPaneKey }
        delete next[paneKey]
        const hasLive = paneKey in s.agentStatusByPaneKey
        if (!hasLive || paneKey in s.retentionSuppressedPaneKeys) {
          return { retainedAgentsByPaneKey: next }
        }
        return {
          retainedAgentsByPaneKey: next,
          retentionSuppressedPaneKeys: {
            ...s.retentionSuppressedPaneKeys,
            [paneKey]: true
          }
        }
      })
    },

    dismissRetainedAgents: (paneKeys) => {
      set((s) => {
        let next: Record<string, RetainedAgentEntry> | null = null
        let nextSuppressed: Record<string, true> | null = null
        for (const paneKey of paneKeys) {
          if (!(paneKey in (next ?? s.retainedAgentsByPaneKey))) {
            continue
          }
          if (next === null) {
            next = { ...s.retainedAgentsByPaneKey }
          }
          delete next[paneKey]
          if (paneKey in s.agentStatusByPaneKey && !(paneKey in s.retentionSuppressedPaneKeys)) {
            if (nextSuppressed === null) {
              nextSuppressed = { ...s.retentionSuppressedPaneKeys }
            }
            nextSuppressed[paneKey] = true
          }
        }
        if (next === null) {
          return s
        }
        return {
          retainedAgentsByPaneKey: next,
          ...(nextSuppressed ? { retentionSuppressedPaneKeys: nextSuppressed } : {})
        }
      })
    },

    dismissRetainedAgentsByWorktree: (worktreeId) => {
      const dismissedPaneKeys: string[] = []
      set((s) => {
        let changed = false
        const next: Record<string, RetainedAgentEntry> = {}
        const toSuppress: string[] = []
        for (const [key, retained] of Object.entries(s.retainedAgentsByPaneKey)) {
          if (retained.worktreeId === worktreeId) {
            changed = true
            dismissedPaneKeys.push(key)
            if (key in s.agentStatusByPaneKey && !(key in s.retentionSuppressedPaneKeys)) {
              toSuppress.push(key)
            }
          } else {
            next[key] = retained
          }
        }
        if (!changed) {
          return s
        }
        if (toSuppress.length === 0) {
          return { retainedAgentsByPaneKey: next }
        }
        const nextSuppressed = { ...s.retentionSuppressedPaneKeys }
        for (const key of toSuppress) {
          nextSuppressed[key] = true
        }
        return {
          retainedAgentsByPaneKey: next,
          retentionSuppressedPaneKeys: nextSuppressed
        }
      })
      if (typeof window !== 'undefined') {
        for (const paneKey of dismissedPaneKeys) {
          window.api?.agentStatus?.drop?.(paneKey)
        }
      }
    },

    pruneRetainedAgents: (validWorktreeIds, liveLeafIdsByTabId) => {
      set((s) => {
        let changed = false
        const next: Record<string, RetainedAgentEntry> = {}
        for (const [key, retained] of Object.entries(s.retainedAgentsByPaneKey)) {
          const orphaned =
            !validWorktreeIds.has(retained.worktreeId) ||
            (liveLeafIdsByTabId !== undefined &&
              retainedRowIsOrphaned(retained, liveLeafIdsByTabId))
          if (orphaned) {
            changed = true
          } else {
            next[key] = retained
          }
        }
        return changed ? { retainedAgentsByPaneKey: next } : s
      })
    },

    clearRetentionSuppressedPaneKeys: (paneKeys) => {
      set((s) => {
        let changed = false
        const next = { ...s.retentionSuppressedPaneKeys }
        for (const paneKey of paneKeys) {
          if (!(paneKey in next)) {
            continue
          }
          delete next[paneKey]
          changed = true
        }
        return changed ? { retentionSuppressedPaneKeys: next } : s
      })
    }
  }
}
