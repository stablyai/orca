import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { isStructuredAgentSessionHostTabId } from '../../../../shared/structured-agent-session-host-tab-id'

/** Where a switch published a row: in the tab it replaced's slot, or beside a split pane's tab. */
export type SlotAnchor = { hostTabId: string; after: boolean }

export function slotAnchorOf(row: RuntimeMobileSessionTabsResult['tabs'][number]) {
  if (row.type !== 'terminal' && row.type !== 'agent-session') {
    return undefined
  }
  return row.replaces
    ? { hostTabId: row.replaces.tabId, after: false }
    : row.after
      ? { hostTabId: row.after.tabId, after: true }
      : undefined
}

type LocalTabIndex = { byId: Map<string, Tab>; chatByEntity: Map<string, Tab> }
const localTabIndexes = new WeakMap<readonly Tab[], LocalTabIndex>()

/** This client's tabs by id and its chats by session, built once per tab list (O(tabs)) and
 *  shared by every anchored row an apply resolves; nothing builds it without an anchor. */
export function localTabIndex(unifiedTabs: readonly Tab[]): LocalTabIndex {
  let index = localTabIndexes.get(unifiedTabs)
  if (!index) {
    index = { byId: new Map(), chatByEntity: new Map() }
    for (const tab of unifiedTabs) {
      index.byId.set(tab.id, tab)
      if (tab.contentType === 'agent-session' && !index.chatByEntity.has(tab.entityId)) {
        index.chatByEntity.set(tab.entityId, tab)
      }
    }
    localTabIndexes.set(unifiedTabs, index)
  }
  return index
}

/** This client's ids for a tab the host names; a replaced chat has left the snapshot, so it is
 *  found by its session. */
export function slotAnchorLocalTabIds(
  unifiedTabs: readonly Tab[],
  hostTabId: string,
  hostToLocalTabId?: ReadonlyMap<string, string>
): string[] {
  const chat = isStructuredAgentSessionHostTabId(hostTabId)
    ? localTabIndex(unifiedTabs).chatByEntity.get(hostTabId.slice('agent-session:'.length))
    : undefined
  return [
    ...(chat ? [chat.id] : []),
    ...[hostTabId, toWebTerminalSurfaceTabId(hostTabId)].map(
      (id) => hostToLocalTabId?.get(id) ?? id
    )
  ]
}

/** A new row in a replaced tab's slot keeps that tab's pin on this client: the pin is this
 *  client's own, so the host's flag never overrides it. Undefined when this client never showed
 *  the replaced tab; a tab beside a split pane inherits nothing. */
export function replacedTabPinned(
  unifiedTabs: readonly Tab[],
  row: RuntimeMobileSessionTabsResult['tabs'][number]
): boolean | undefined {
  const anchor = slotAnchorOf(row)
  const ids = anchor && !anchor.after ? slotAnchorLocalTabIds(unifiedTabs, anchor.hostTabId) : []
  const byId = ids.length > 0 ? localTabIndex(unifiedTabs).byId : undefined
  const replaced = ids.map((id) => byId?.get(id)).find((tab) => tab !== undefined)
  return replaced ? replaced.isPinned === true : undefined
}
