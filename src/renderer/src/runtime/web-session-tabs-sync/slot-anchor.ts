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

/** This client's ids for a tab the host names; a replaced chat has left the snapshot, so it is
 *  found by its session. */
export function slotAnchorLocalTabIds(
  unifiedTabs: readonly Tab[],
  hostTabId: string,
  hostToLocalTabId?: ReadonlyMap<string, string>
): string[] {
  const chat = isStructuredAgentSessionHostTabId(hostTabId)
    ? unifiedTabs.find(
        (tab) =>
          tab.contentType === 'agent-session' &&
          tab.entityId === hostTabId.slice('agent-session:'.length)
      )
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
  const replaced = unifiedTabs.find((tab) => ids.includes(tab.id))
  return replaced ? replaced.isPinned === true : undefined
}
