import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import { logicalTabIdOf } from '../../../../shared/runtime-mobile-session-tab-contracts'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { localTabIdsByHostLogicalTab } from './tracking-mappings'

type Row = RuntimeMobileSessionTabsResult['tabs'][number]

/**
 * A switch changes what a host tab holds and the tab keeps its layout id (`logicalTabIdOf`). This
 * client names content by its own id, so the change is a rename of the local tab that showed the
 * old content there: the new content takes its pin, and the rekey keeps its place and selection.
 * Undefined for a row whose tab this client never showed, or still shows with its old content.
 */
export function switchedTabRenames(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  unifiedTabs: readonly Tab[]
): (row: Row) => Tab | undefined {
  const previous = localTabIdsByHostLogicalTab(environmentId, snapshot.worktree)
  if (previous.size === 0) {
    return () => undefined
  }
  const byId = new Map(unifiedTabs.map((tab) => [tab.id, tab]))
  const listed = new Set(
    snapshot.tabs.flatMap((row) =>
      row.type === 'terminal'
        ? [toWebTerminalSurfaceTabId(row.parentTabId)]
        : row.type === 'agent-session'
          ? [row.sessionId]
          : []
    )
  )
  return (row) => {
    const tab = byId.get(previous.get(logicalTabIdOf(row)) ?? '')
    return tab &&
      (tab.contentType === 'terminal' || tab.contentType === 'agent-session') &&
      !listed.has(tab.entityId)
      ? tab
      : undefined
  }
}
