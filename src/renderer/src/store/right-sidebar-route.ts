import type {
  ActiveRightSidebarTab,
  RightSidebarExplorerView
} from '../../../shared/ui-chrome-types'
import { isPluginPanelTabKey } from '../../../shared/plugins/plugin-tab-key'

export type RightSidebarRoute = {
  rightSidebarTab: ActiveRightSidebarTab
  rightSidebarExplorerView: RightSidebarExplorerView
}

function normalizeRightSidebarExplorerView(view: unknown): RightSidebarExplorerView {
  return view === 'search' ? 'search' : 'files'
}

export type NormalizeRightSidebarRouteOptions = {
  /** Drop keys only for known-uninstalled plugins, retaining disabled/unknown-during-hydration routes; render-time resolveRightSidebarEffectiveTab still guards. */
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
  // Plugin keys are open-ended; validate shape so restart does not reset valid routes to Explorer.
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
