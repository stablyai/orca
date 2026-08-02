import type { ActiveRightSidebarTab, RightSidebarExplorerView } from '../../../shared/types'
import { isPluginPanelTabKey } from '../../../shared/plugins/plugin-manifest'

export type RightSidebarRoute = {
  rightSidebarTab: ActiveRightSidebarTab
  rightSidebarExplorerView: RightSidebarExplorerView
}

function normalizeRightSidebarExplorerView(view: unknown): RightSidebarExplorerView {
  return view === 'search' ? 'search' : 'files'
}

export type NormalizeRightSidebarRouteOptions = {
  /** Tab keys of currently installed plugin panels. When provided, persisted
   *  keys for UNINSTALLED plugins are dropped (reset to Explorer); merely
   *  disabled plugins keep their key and fall back at render time via
   *  resolveRightSidebarEffectiveTab. Omit when the installed list is not
   *  known yet (early hydration) — the render-time fallback still guards. */
  installedPluginTabKeys?: ReadonlySet<string>
}

export function normalizeRightSidebarRoute(
  tab: unknown,
  explorerView?: unknown,
  options?: NormalizeRightSidebarRouteOptions
): RightSidebarRoute {
  // Why: older builds persisted Search as a standalone activity tab.
  if (tab === 'search') {
    return { rightSidebarTab: 'explorer', rightSidebarExplorerView: 'search' }
  }
  // Why: plugin tabs are open-ended keys; validate their shape so a persisted
  // plugin tab isn't reset to Explorer on restart.
  if (typeof tab === 'string' && isPluginPanelTabKey(tab)) {
    if (options?.installedPluginTabKeys && !options.installedPluginTabKeys.has(tab)) {
      return { rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files' }
    }
    return { rightSidebarTab: tab, rightSidebarExplorerView: 'files' }
  }
  if (
    tab === 'explorer' ||
    tab === 'vault' ||
    tab === 'workspaces' ||
    tab === 'pr-checks' ||
    tab === 'source-control' ||
    tab === 'checks' ||
    tab === 'ports'
  ) {
    return {
      rightSidebarTab: tab,
      rightSidebarExplorerView:
        tab === 'explorer' ? normalizeRightSidebarExplorerView(explorerView) : 'files'
    }
  }
  return { rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files' }
}
