import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { DASHBOARD_MAX_LABEL_LENGTH } from '../../../../shared/dashboard-snapshot'
import type { FloatingWorkspaceWindowSnapshot } from '../../../../shared/floating-workspace-window'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { AppState } from '@/store/types'
import { readDashboardClientHost } from '../dashboard/dashboard-client-host'
import { resolveDashboardCardTerminalInput } from '../dashboard/dashboard-card-terminal-input'
import { dashboardCardDotState } from '../dashboard/dashboard-row-bucket'

/** The focused floating group's active tab; the window shows that one terminal pane only. */
export function buildFloatingWorkspaceWindowSnapshot(
  state: AppState
): FloatingWorkspaceWindowSnapshot {
  const groups = state.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
  const focusedId = state.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  const group = groups.find((g) => g.id === focusedId) ?? groups.find((g) => g.activeTabId != null)
  const tab = state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.find(
    (candidate) => candidate.id === group?.activeTabId
  )
  if (!tab) {
    return { version: 1, activeTab: null }
  }
  const title = (tab.customLabel ?? tab.label).slice(0, DASHBOARD_MAX_LABEL_LENGTH)
  const terminal =
    tab.contentType === 'terminal'
      ? state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.find((t) => t.id === tab.entityId)
      : undefined
  if (!terminal) {
    return {
      version: 1,
      activeTab: {
        tabId: tab.id,
        title,
        kind: 'other',
        status: 'idle',
        paneKey: tab.id,
        ptyId: null
      }
    }
  }
  const layout = state.terminalLayoutsByTabId[terminal.id]
  const leafId = layout?.activeLeafId
  const paneKey =
    leafId && isTerminalLeafId(leafId) ? makePaneKey(terminal.id, leafId) : terminal.id
  const layoutPtyId = (leafId ? layout?.ptyIdsByLeafId?.[leafId] : undefined) ?? null
  // Layouts survive restarts; only a PTY the live set still holds is connectable.
  const ptyId =
    layoutPtyId && (state.ptyIdsByTabId[terminal.id] ?? []).includes(layoutPtyId)
      ? layoutPtyId
      : null
  const entry = state.agentStatusByPaneKey[paneKey]
  const clientHost = readDashboardClientHost()
  return {
    version: 1,
    activeTab: {
      tabId: terminal.id,
      title,
      kind: 'terminal',
      status: entry ? dashboardCardDotState(entry.state) : 'idle',
      paneKey,
      ptyId,
      ...(ptyId
        ? {
            terminalInput: resolveDashboardCardTerminalInput(state, {
              ptyId,
              worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
              paneKey,
              cwd: state.floatingWorkspacePath ?? '',
              shellOverride: terminal.shellOverride,
              launchAgent: terminal.launchAgent,
              clientPlatform: clientHost.platform,
              userAgent: clientHost.userAgent,
              osRelease: clientHost.osRelease
            })
          }
        : {})
    }
  }
}
