import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { batchAgentPaneKeysForTabs, isMirroredAgentStatusOwnedBy } from './agent-status-primitives'
import { isMirroredTerminalSurfaceId } from './terminal-surfaces'
import type { WebSessionTabsBatchContext, WebSessionTabsSyncState } from './state'

function recordPaneKeysForTabs(
  record: Readonly<Record<string, unknown>> | undefined,
  tabIds: ReadonlySet<string>,
  batchContext?: WebSessionTabsBatchContext,
  paneKeyInValue = false
): string[] {
  if (!record) {
    return []
  }
  const indexes = batchContext
    ? (batchContext.retractionPaneKeysByRecord ??= new WeakMap())
    : undefined
  let index = indexes?.get(record)
  if (!index) {
    index = new Map<string, Set<string>>()
    for (const [key, value] of Object.entries(record)) {
      const paneKey = paneKeyInValue
        ? typeof value === 'object' &&
          value !== null &&
          'paneKey' in value &&
          typeof value.paneKey === 'string'
          ? value.paneKey
          : undefined
        : key
      const tabId = paneKey ? parsePaneKey(paneKey)?.tabId : undefined
      if (!paneKey || !tabId) {
        continue
      }
      const keys = index.get(tabId) ?? new Set<string>()
      keys.add(paneKey)
      index.set(tabId, keys)
    }
    indexes?.set(record, index)
  }
  return [...tabIds].flatMap((tabId) => [...(index.get(tabId) ?? [])])
}

/** Unknown pane ownership prevents tab-wide cleanup, only for the colliding tab. */
export function collectCollidingRetractionPaneKeys(
  state: WebSessionTabsSyncState,
  retractedTabIds: readonly string[],
  environmentId: string,
  worktreeId: string,
  batchContext?: WebSessionTabsBatchContext
): ReadonlyMap<string, ReadonlySet<string>> {
  const tabIds = new Set(retractedTabIds.filter(isMirroredTerminalSurfaceId))
  const collisions = new Map<string, ReadonlySet<string>>()
  if (tabIds.size === 0) {
    return collisions
  }
  const keys = new Set(batchAgentPaneKeysForTabs(state, tabIds, batchContext))
  for (const record of [
    state.retainedAgentsByPaneKey,
    state.acknowledgedAgentsByPaneKey,
    state.agentLaunchConfigByPaneKey,
    state.paneForegroundAgentByPaneKey
  ]) {
    for (const key of recordPaneKeysForTabs(record, tabIds, batchContext)) {
      keys.add(key)
    }
  }
  for (const key of recordPaneKeysForTabs(
    state.migrationUnsupportedByPtyId,
    tabIds,
    batchContext,
    true
  )) {
    keys.add(key)
  }
  const owned = new Map<string, Set<string>>()
  const foreignTabs = new Set<string>()
  for (const paneKey of keys) {
    const tabId = parsePaneKey(paneKey)?.tabId
    if (!tabId || !tabIds.has(tabId)) {
      continue
    }
    const entry =
      state.agentStatusByPaneKey[paneKey] ?? state.retainedAgentsByPaneKey?.[paneKey]?.entry
    if (entry && isMirroredAgentStatusOwnedBy(entry, environmentId, worktreeId)) {
      const panes = owned.get(tabId) ?? new Set<string>()
      panes.add(paneKey)
      owned.set(tabId, panes)
    } else {
      foreignTabs.add(tabId)
    }
  }
  for (const tabId of foreignTabs) {
    collisions.set(tabId, owned.get(tabId) ?? new Set())
  }
  return collisions
}
