import type { Tab } from '../../../../shared/tab-types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'

/**
 * A paired client's tab for a host tab is keyed by the host's layout tab id (`logicalTabId`), which
 * a switch keeps; what it holds (`contentType`, `entityId`) is separate, so a host switch changes
 * the content under the same local tab and its place, pin and selection stay where they were, on
 * every load. The id takes the form that row's tab has always had here (a terminal tab's
 * `web-terminal-<id>`, a chat tab's own id), so a tab that never switched keeps today's id. A row
 * from an older host names no layout id: its content keys the tab, as before.
 */
export function mirroredTabContainers(
  unifiedTabs: readonly Tab[],
  executionHostId: string
): (logicalTabId: string | undefined) => Tab | undefined {
  // This host's tabs only: another host's layout ids are never this one's.
  const byId = new Map(
    unifiedTabs.flatMap((tab) => (tab.executionHostId === executionHostId ? [[tab.id, tab]] : []))
  )
  return (logicalTabId) =>
    logicalTabId === undefined
      ? undefined
      : (byId.get(toWebTerminalSurfaceTabId(logicalTabId)) ?? byId.get(logicalTabId))
}
