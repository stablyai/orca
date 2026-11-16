import { readRecordChanges } from '@/store/keyed-record-change-reads'
import { isIndexKey } from '@/store/keyed-record-index-keys'
import {
  collectLiveMetadata,
  collectSleepingMetadata,
  getPaneKeyTabId,
  type IndexedAgentEntry,
  type WorkspaceTabAgentMetadataState
} from './workspace-tab-agent-metadata'

type IndexedPane = { tabId: string; entry: IndexedAgentEntry; live: boolean; order: number }

/** Palette-local projection; authoritative rows and their existing change signals own invalidation. */
export function createWorkspaceTabAgentIndex() {
  let previous: WorkspaceTabAgentMetadataState | undefined
  let cursor = 0
  let nextOrder = 0
  const liveOrder = new Map<string, number>()
  const sleepingOrder = new Map<string, number>()
  const records = new Map<string, readonly unknown[]>()
  const panes = new Map<string, IndexedPane>()
  const buckets = new Map<string, Map<string, IndexedPane>>()
  const index = new Map<string, readonly IndexedAgentEntry[]>()

  return {
    index,
    update(state: WorkspaceTabAgentMetadataState): ReadonlySet<string> | null {
      const statuses = state.agentStatusByPaneKey
      const projection = statuses.projection
      const keys = new Set<string>()
      let full = !previous || !statuses.sharesOwner(previous.agentStatusByPaneKey)
      if (!full) {
        const changed = projection.changesSince(cursor)
        if (changed === null) {
          full = true
        } else {
          changed.forEach((key) => keys.add(key))
        }
        const sleeping = readRecordChanges(
          state.sleepingAgentSessionsByPaneKey,
          previous!.sleepingAgentSessionsByPaneKey
        )
        if (sleeping?.kind === 'full-resync') {
          full = true
        } else if (sleeping) {
          for (const key of sleeping.added) {
            sleepingOrder.set(key, nextOrder++)
          }
          sleeping.keys.forEach((key) => keys.add(key))
        }
      }
      if (full) {
        records.clear()
        panes.clear()
        buckets.clear()
        index.clear()
        liveOrder.clear()
        sleepingOrder.clear()
        nextOrder = 0
        for (const key of statuses.keys()) {
          liveOrder.set(key, nextOrder++)
          keys.add(key)
        }
        for (const key of Object.keys(state.sleepingAgentSessionsByPaneKey)) {
          sleepingOrder.set(key, nextOrder++)
          keys.add(key)
        }
      }
      const dirtyTabs = new Set<string>()
      for (const key of keys) {
        const paneTab = getPaneKeyTabId(key)
        if (paneTab) {
          dirtyTabs.add(paneTab)
        }
        const live = statuses.get(key)
        const sleeping = state.sleepingAgentSessionsByPaneKey[key]
        const priorRecords = records.get(key)
        if (priorRecords && priorRecords[0] === live && priorRecords[1] === sleeping) {
          const tabId = panes.get(key)?.tabId
          if (tabId) {
            dirtyTabs.add(tabId)
          }
          continue
        }
        if (live || sleeping) {
          records.set(key, [live, sleeping])
        } else {
          records.delete(key)
        }
        const before = panes.get(key)
        if (before) {
          buckets.get(before.tabId)?.delete(key)
          dirtyTabs.add(before.tabId)
          panes.delete(key)
        }
        if (!live) {
          liveOrder.delete(key)
        }
        if (!sleeping) {
          sleepingOrder.delete(key)
        }
        if (live && !liveOrder.has(key)) {
          liveOrder.set(key, nextOrder++)
        }
        if (sleeping && !sleepingOrder.has(key)) {
          sleepingOrder.set(key, nextOrder++)
        }
        const liveTabId = live && (live.tabId || paneTab)
        const record = liveTabId ? live : sleeping
        const tabId = liveTabId || (sleeping && (sleeping.tabId || paneTab))
        if (!record || !tabId) {
          continue
        }
        const pane: IndexedPane = {
          tabId,
          live: !!liveTabId,
          order: (liveTabId ? liveOrder : sleepingOrder).get(key)!,
          entry: {
            paneKey: key,
            worktreeId: record.worktreeId,
            connectionId: record.connectionId,
            metadata: {
              paneKey: key,
              ...(liveTabId ? collectLiveMetadata(live!) : collectSleepingMetadata(sleeping!))
            }
          }
        }
        panes.set(key, pane)
        let bucket = buckets.get(tabId)
        if (!bucket) {
          buckets.set(tabId, (bucket = new Map()))
        }
        bucket.set(key, pane)
        dirtyTabs.add(tabId)
      }
      for (const tabId of dirtyTabs) {
        const bucket = buckets.get(tabId)
        if (!bucket?.size) {
          buckets.delete(tabId)
          index.delete(tabId)
          continue
        }
        index.set(
          tabId,
          [...bucket.values()]
            .sort((a, b) => {
              if (a.live !== b.live) {
                return a.live ? -1 : 1
              }
              if (!a.live) {
                const aKey = a.entry.paneKey
                const bKey = b.entry.paneKey
                const aNumeric = isIndexKey(aKey)
                const bNumeric = isIndexKey(bKey)
                if (aNumeric || bNumeric) {
                  return aNumeric && bNumeric ? Number(aKey) - Number(bKey) : aNumeric ? -1 : 1
                }
              }
              return a.order - b.order
            })
            .map((pane) => pane.entry)
        )
      }
      previous = state
      cursor = projection.changeCursor()
      return full ? null : dirtyTabs
    }
  }
}
