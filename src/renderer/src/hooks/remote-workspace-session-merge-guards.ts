import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { collectLeafIdsInOrder } from '../components/terminal-pane/terminal-layout-leaf-ids'

export function isTargetPtyId(ptyId: string | null | undefined, targetId: string): ptyId is string {
  return Boolean(ptyId && parseAppSshPtyId(ptyId)?.connectionId === targetId)
}

export function hasAmbiguousResultTabIds(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  replaceWorktreeIds: ReadonlySet<string>
): boolean {
  const ownerByTabId = new Map<string, string>()
  const addOwner = (worktreeId: string, tab: TerminalTab): boolean => {
    const tabId = tab.id
    const owner = ownerByTabId.get(tabId)
    if (owner && owner !== worktreeId) {
      return false
    }
    ownerByTabId.set(tabId, worktreeId)
    return true
  }
  for (const [worktreeId, tabs] of Object.entries(current.tabsByWorktree)) {
    if (!replaceWorktreeIds.has(worktreeId)) {
      for (const tab of tabs) {
        if (!addOwner(worktreeId, tab)) {
          return true
        }
      }
    }
  }
  for (const [worktreeId, tabs] of Object.entries(remote.tabsByWorktree)) {
    for (const tab of tabs) {
      if (!addOwner(worktreeId, tab)) {
        return true
      }
    }
  }
  return false
}

export function targetLayout(
  session: WorkspaceSessionState,
  tabId: string,
  targetId: string
): WorkspaceSessionState['terminalLayoutsByTabId'][string] | undefined {
  const layout = session.terminalLayoutsByTabId[tabId]
  if (
    !layout ||
    Object.values(layout.ptyIdsByLeafId ?? {}).some((ptyId) => !isTargetPtyId(ptyId, targetId))
  ) {
    return undefined
  }
  return layout
}

export function retainedLocalPtyId(
  current: WorkspaceSessionState,
  reconnectPtyIdByTabId: Readonly<Record<string, string>>,
  tabId: string,
  targetId: string,
  allowTabKeyedRecovery: boolean
): string | undefined {
  const layout = targetLayout(current, tabId, targetId)
  const mountedLeafIds = collectLeafIdsInOrder(layout?.root)
  const primaryLeafId =
    layout?.activeLeafId && mountedLeafIds.includes(layout.activeLeafId)
      ? layout.activeLeafId
      : mountedLeafIds[0]
  const layoutPtyId = primaryLeafId ? layout?.ptyIdsByLeafId?.[primaryLeafId] : undefined
  const reconnectPtyId = allowTabKeyedRecovery ? reconnectPtyIdByTabId[tabId] : undefined
  return isTargetPtyId(reconnectPtyId, targetId)
    ? reconnectPtyId
    : isTargetPtyId(layoutPtyId, targetId)
      ? layoutPtyId
      : undefined
}
