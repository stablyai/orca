import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-owner'
import { resolveLocalTabIdForHostSessionTab } from '@/runtime/web-session-tabs-sync/tracking-mappings'
import { windowPublishedRowId } from '@/runtime/sync-runtime-graph/mobile-session-group-projection'
import { publishedHostTabIds } from '@/runtime/sync-runtime-graph/mobile-session-inputs'
import { useAppStore } from '../../store'

/** Main addresses its own session-tab ids; a mirrored chat tab lives here under a different id. */
export function resolveWindowTabIdForHostTab(worktreeId: string, tabId: string): string {
  return (
    resolveLocalTabIdForHostSessionTab({
      environmentId: LOCAL_STRUCTURED_SESSION_OWNER,
      worktreeId,
      hostTabId: tabId
    }) ?? tabId
  )
}

/** Main names a window tab in a move or close by the row this window publishes for its current
 *  content (`windowPublishedRowId`), and by no other spelling: a terminal's id never lands on a
 *  tab a switch left holding a chat, a stale chat row on one now holding a terminal, nor a chat's
 *  retired session row on that chat once it reopened under its own row. A chat's session is
 *  addressed only by History's typed activation. */
export function windowTabIdsByRowId(worktreeId: string): (rowId: string) => string | null {
  const state = useAppStore.getState()
  const hostTabIds = publishedHostTabIds(state, worktreeId)
  const tabIdByRow = new Map<string, string>()
  for (const tab of state.unifiedTabsByWorktree[worktreeId] ?? []) {
    const row = windowPublishedRowId(tab.contentType, tab.entityId, tab.id, hostTabIds.get(tab.id))
    if (!tabIdByRow.has(row)) {
      tabIdByRow.set(row, tab.id)
    }
  }
  return (rowId) => tabIdByRow.get(rowId) ?? null
}
