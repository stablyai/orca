import type { AppState } from '@/store/types'
import { getActiveTabNavOrder, getGroupVisibleTabOrder } from '@/components/tab-bar/group-tab-order'
import type { VisibleTabRef } from '@/components/tab-bar/group-tab-order'
import { workspaceMarkerTabs } from '@/store/slices/workspace-attention/workspace-live-markers'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

/** A workspace tab that can own attention: a terminal, or a structured chat with its current session. */
export type OrderedTab =
  | { kind: 'terminal'; terminalTab: TerminalTab; unifiedTabId?: string }
  | { kind: 'agent-session'; unifiedTabId: string; sessionId: string | null }

// Why fixed group order: putting the active group first would re-rank on every jump and trap the cycle between two groups.
export function orderedWorkspaceTabs(state: AppState, worktreeId: string): OrderedTab[] {
  const terminalTabs = state.tabsByWorktree[worktreeId] ?? []
  const terminalById = new Map(terminalTabs.map((tab) => [tab.id, tab]))
  const unifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const unifiedById = new Map(unifiedTabs.map((tab) => [tab.id, tab]))
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const refs: VisibleTabRef[] = []
  if (groups.length === 0) {
    refs.push(...getActiveTabNavOrder(state, worktreeId))
  }
  for (const group of groups) {
    const groupTabs = unifiedTabs.filter((tab) => tab.groupId === group.id)
    const terminalIds = new Set([
      ...terminalById.keys(),
      ...groupTabs.filter((tab) => tab.contentType === 'terminal').map((tab) => tab.entityId)
    ])
    refs.push(...getGroupVisibleTabOrder(group, groupTabs, terminalIds, new Set(), new Set()))
  }

  const ordered: OrderedTab[] = []
  const seen = new Set<string>()
  const pushTerminal = (terminalTab: TerminalTab | undefined, unifiedTabId?: string): void => {
    if (terminalTab && !seen.has(terminalTab.id)) {
      seen.add(terminalTab.id)
      ordered.push({ kind: 'terminal', terminalTab, unifiedTabId })
    }
  }
  const sessionIdByTabId = new Map(
    workspaceMarkerTabs(state, worktreeId).map((tab) => [tab.id, tab.sessionId])
  )
  const pushChat = (unifiedTabId: string): void => {
    if (!seen.has(unifiedTabId) && unifiedById.get(unifiedTabId)?.contentType === 'agent-session') {
      seen.add(unifiedTabId)
      ordered.push({
        kind: 'agent-session',
        unifiedTabId,
        sessionId: sessionIdByTabId.get(unifiedTabId) ?? null
      })
    }
  }
  for (const ref of refs) {
    if (ref.type === 'terminal') {
      pushTerminal(terminalById.get(ref.id), ref.tabId)
    } else if (ref.type === 'agent-session') {
      pushChat(ref.tabId ?? ref.id)
    }
  }
  // Tabs no strip lists yet still own their attention; they trail the strip order.
  for (const tab of terminalTabs) {
    pushTerminal(tab)
  }
  for (const tab of unifiedTabs) {
    pushChat(tab.id)
  }
  return ordered
}
