import { useAppStore } from '@/store'
import type { WorkspaceViewPlacement } from '../../../../shared/workspace-view-bridge'
import { captureWorkspaceViews, importWorkspaceViews } from './workspace-view-packet'
import { resolveHosts } from './workspace-view-session-readiness'
import { recordWindowPaneChange } from '@/store/slices/window-pane-history'

export async function selectWorkspaceViewPlacement(
  placement: WorkspaceViewPlacement,
  action: 'visit' | 'here' | 'beside'
): Promise<boolean> {
  const location = {
    windowId: placement.windowId,
    epoch: placement.epoch,
    paneId: placement.paneId,
    viewId: placement.view.id
  }
  const state = useAppStore.getState()
  const paneId = state.windowPaneLayout?.activePaneId
  const bridge = window.orcaWorkspaceViews
  if (action === 'visit') {
    if (bridge?.visit) {
      return bridge.visit(location)
    }
    if (!state.windowPaneLayout?.panes[location.paneId]?.viewIds.includes(location.viewId)) {
      return false
    }
    state.focusWindowPane(location.paneId, location.viewId)
    state.setActiveView('terminal')
    return true
  }
  if (!paneId) {
    return false
  }
  const target = { paneId, zone: action === 'here' ? ('center' as const) : ('right' as const) }
  if (bridge?.open) {
    return bridge.open(location, target)
  }
  const hosts = await resolveHosts()
  const current = useAppStore.getState()
  if (!current.windowPaneLayout?.panes[location.paneId]?.viewIds.includes(location.viewId)) {
    return false
  }
  const packet = captureWorkspaceViews(current, [location.viewId], hosts)
  useAppStore.setState(
    recordWindowPaneChange(current, importWorkspaceViews(current, packet, 'tabs', hosts, target))
  )
  return true
}
