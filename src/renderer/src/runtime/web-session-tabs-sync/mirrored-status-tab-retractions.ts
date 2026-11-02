import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { isWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import type { WebSessionTabsBatchContext, WebSessionTabsSyncState } from './state'
import { batchAgentPaneKeysForTabs } from './agent-status-primitives'
import { hostSessionTabIdsByLocalTabForWorktree } from './tracking-mappings'

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
  // The mapping also keys containers; a container's id names no terminal, whatever its spelling.
  const containerIds = new Set(
    (args.state.unifiedTabsByWorktree[args.worktreeId] ?? []).flatMap((tab) =>
      tab.contentType === 'terminal' && tab.entityId === tab.id ? [] : [tab.id]
    )
  )
  for (const [tabId, hostTabId] of hostSessionTabIdsByLocalTabForWorktree(
    args.environmentId,
    args.worktreeId
  )) {
    if (
      isWebTerminalSurfaceTabId(tabId) &&
      !containerIds.has(tabId) &&
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
  for (const paneKey of batchAgentPaneKeysForTabs(args.state, candidates, args.batchContext)) {
    const entry = args.state.agentStatusByPaneKey[paneKey]
    const tabId = parsePaneKey(paneKey)?.tabId
    if (
      entry?.worktreeId === args.worktreeId &&
      (entry.connectionId === args.environmentId ||
        (args.environmentId === 'local' &&
          (entry.connectionId === null || entry.connectionId === undefined))) &&
      tabId &&
      candidates.has(tabId)
    ) {
      retracted.add(tabId)
    }
  }
  return [...retracted]
}
