import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import {
  makePaneKey,
  parseLegacyNumericPaneKey
} from '../../../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { resolveRuntimePaneTitleLeafId } from '../../../../../../shared/workspace-layout/terminal-topology/runtime-pane-title-leaf-id'

/**
 * Title row a legacy `tabId:N` status key stands for. Runtime slots keep gaps after a pane
 * closes, so replay order can name a sibling; it only reaches rows built without a live slot.
 */
export function legacyStatusTitleRowKey(
  paneKey: string,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined> | undefined,
  titleRowsOfTab: (tabId: string) => Iterable<DashboardAgentRow | null | undefined>
): string | null {
  const legacy = parseLegacyNumericPaneKey(paneKey)
  if (!legacy) {
    return null
  }
  const slot = Number(legacy.numericPaneId)
  const replayLeafId = resolveRuntimePaneTitleLeafId(
    terminalLayoutsByTabId?.[legacy.tabId],
    legacy.numericPaneId
  )
  let replayKey = replayLeafId ? makePaneKey(legacy.tabId, replayLeafId) : null
  for (const row of titleRowsOfTab(legacy.tabId)) {
    if (!row) {
      continue
    }
    if (row.runtimePaneId === slot) {
      return row.paneKey
    }
    if (row.paneKey === replayKey && row.runtimePaneId !== undefined) {
      replayKey = null
    }
  }
  return replayKey
}
