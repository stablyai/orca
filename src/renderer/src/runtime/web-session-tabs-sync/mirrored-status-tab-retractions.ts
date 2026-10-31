import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { isWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import type { WebSessionTabsBatchContext, WebSessionTabsSyncState } from './state'
import { batchAgentPaneKeysForTabs } from './agent-status-primitives'
import { hostSessionTabIdsByLocalTabForWorktree } from './tracking-mappings'
import { recordPaneKeysForTabs } from './retraction-pane-ownership'

/** Reuse the host mapping when a status row outlives this renderer's tab inventory. */
export function collectUnhydratedMirroredTabRetractions(args: {
  state: WebSessionTabsSyncState
  environmentId: string
  worktreeId: string
  nextHostTerminalTabIds: ReadonlySet<string>
  currentTerminalIds: ReadonlySet<string>
  batchContext?: WebSessionTabsBatchContext
}): string[] {
  const candidates = new Set<string>()
  for (const [tabId, hostTabId] of hostSessionTabIdsByLocalTabForWorktree(
    args.environmentId,
    args.worktreeId
  )) {
    if (
      isWebTerminalSurfaceTabId(tabId) &&
      !args.currentTerminalIds.has(tabId) &&
      !args.nextHostTerminalTabIds.has(hostTabId)
    ) {
      candidates.add(tabId)
    }
  }
  if (candidates.size === 0) {
    return []
  }
  const retracted = new Set<string>()
  const keys = new Set(batchAgentPaneKeysForTabs(args.state, candidates, args.batchContext))
  for (const paneKey of recordPaneKeysForTabs(
    args.state.paneForegroundAgentByPaneKey,
    candidates,
    args.batchContext
  )) {
    const entry = args.state.paneForegroundAgentByPaneKey?.[paneKey]
    if (
      entry?.context?.worktreeId === args.worktreeId &&
      (entry.context.environmentId ?? 'local') === args.environmentId &&
      candidates.has(parsePaneKey(paneKey)?.tabId ?? '')
    ) {
      keys.add(paneKey)
    }
  }
  for (const paneKey of keys) {
    const entry = args.state.agentStatusByPaneKey[paneKey]
    const tabId = parsePaneKey(paneKey)?.tabId
    if (
      (entry
        ? entry.worktreeId === args.worktreeId &&
          (entry.connectionId === args.environmentId ||
            (args.environmentId === 'local' && entry.connectionId == null))
        : args.state.paneForegroundAgentByPaneKey?.[paneKey]?.context?.worktreeId ===
          args.worktreeId) &&
      tabId &&
      candidates.has(tabId)
    ) {
      retracted.add(tabId)
    }
  }
  return [...retracted]
}
