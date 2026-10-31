import { buildForegroundLayoutRetractionPatch } from '../../store/slices/pane-foreground-agent'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { batchAgentPaneKeysForTabs, isMirroredAgentStatusOwnedBy } from './agent-status-primitives'
import { isMirroredTerminalSurfaceId } from './terminal-surfaces'
import type { WebSessionTabsBatchContext, WebSessionTabsSyncState } from './state'
import { writableWebSessionTabsRecord } from './state-equality-core'

export function recordPaneKeysForTabs(
  record: Readonly<Record<string, unknown>> | undefined,
  tabIds: ReadonlySet<string>,
  batchContext?: WebSessionTabsBatchContext,
  paneKeyInValue = false
): string[] {
  if (!record || tabIds.size === 0) {
    return []
  }
  const indexes = batchContext
    ? (batchContext.retractionPaneKeysByRecord ??= new WeakMap())
    : undefined
  let index = indexes?.get(record)
  if (!index) {
    index = new Map<string, Set<string>>()
    for (const key of Object.keys(record)) {
      const value = paneKeyInValue ? record[key] : undefined
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

export function forgetRetractionPaneKey(
  record: NonNullable<WebSessionTabsSyncState['paneForegroundAgentByPaneKey']>,
  paneKey: string,
  batchContext?: WebSessionTabsBatchContext
): void {
  const tabId = parsePaneKey(paneKey)?.tabId
  const index = batchContext?.retractionPaneKeysByRecord?.get(record)
  if (!tabId || !index) {
    return
  }
  const keys = index.get(tabId)
  keys?.delete(paneKey)
  if (keys?.size === 0) {
    index.delete(tabId)
  }
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
    const context = state.paneForegroundAgentByPaneKey?.[paneKey]?.context
    const foregroundOwned =
      context?.worktreeId === worktreeId && (context.environmentId ?? 'local') === environmentId
    if (entry ? isMirroredAgentStatusOwnedBy(entry, environmentId, worktreeId) : foregroundOwned) {
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

export function buildCurrentForegroundLeafRetractionPatch(
  state: WebSessionTabsSyncState,
  entries: WebSessionTabsSyncState['paneForegroundAgentByPaneKey'],
  layouts: WebSessionTabsSyncState['terminalLayoutsByTabId'],
  tabIds: ReadonlySet<string>,
  environmentId: string,
  worktreeId: string,
  batchContext?: WebSessionTabsBatchContext
) {
  const current = entries ?? {}
  const keys = recordPaneKeysForTabs(current, tabIds, batchContext)
  const patch = buildForegroundLayoutRetractionPatch(
    current,
    layouts,
    tabIds,
    (entry, paneKey) => {
      const context = entry.context
      const row =
        state.agentStatusByPaneKey[paneKey] ?? state.retainedAgentsByPaneKey?.[paneKey]?.entry
      return (
        context?.worktreeId === worktreeId &&
        (context.environmentId ?? 'local') === environmentId &&
        (!row || isMirroredAgentStatusOwnedBy(row, environmentId, worktreeId))
      )
    },
    {
      paneKeys: keys,
      ...(batchContext
        ? {
            writable: () =>
              writableWebSessionTabsRecord(state, 'paneForegroundAgentByPaneKey', batchContext)
          }
        : {})
    }
  )
  if (patch) {
    for (const key of keys) {
      if (!(key in patch.paneForegroundAgentByPaneKey)) {
        forgetRetractionPaneKey(patch.paneForegroundAgentByPaneKey, key, batchContext)
      }
    }
  }
  return patch
}
