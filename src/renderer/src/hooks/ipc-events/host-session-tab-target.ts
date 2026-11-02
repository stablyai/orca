import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-owner'
import {
  hostSessionTabIdsByLocalTabForWorktree,
  resolveLocalTabIdForHostSessionTab
} from '@/runtime/web-session-tabs-sync/tracking-mappings'
import { agentSessionRowId } from '../../../../shared/agent-session/view/structured-agent-session-host-tab-id'
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

/** Main names a window tab in a move or close by a row id published for its current content:
 *  this window's own row, or for a chat main's row of that chat. Only a tab whose current content
 *  publishes that id matches, so a terminal's id never lands on a tab a switch left holding a
 *  chat, nor a stale chat row on one now holding a terminal. */
export function windowTabIdsByRowId(worktreeId: string): (rowId: string) => string | null {
  const state = useAppStore.getState()
  const hostTabIds = publishedHostTabIds(state, worktreeId)
  const chatRowIds = hostSessionTabIdsByLocalTabForWorktree(
    LOCAL_STRUCTURED_SESSION_OWNER,
    worktreeId
  )
  const tabIdByRow = new Map<string, string>()
  for (const tab of state.unifiedTabsByWorktree[worktreeId] ?? []) {
    const own = windowPublishedRowId(tab.contentType, tab.entityId, tab.id, hostTabIds.get(tab.id))
    const rows =
      tab.contentType === 'agent-session'
        ? [own, agentSessionRowId(tab.entityId, tab.id), chatRowIds.get(tab.id)]
        : [own]
    for (const row of rows) {
      if (row !== undefined && !tabIdByRow.has(row)) {
        tabIdByRow.set(row, tab.id)
      }
    }
  }
  return (rowId) => tabIdByRow.get(rowId) ?? null
}
