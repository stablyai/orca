import type {
  ActiveRightSidebarTab,
  RightSidebarExplorerView
} from '../../../../../shared/ui-chrome/ui-chrome-types'
import { isPluginPanelTabKey } from '../../../../../shared/plugins/frames/plugin-tab-key'

export type RightSidebarRoute = {
  rightSidebarTab: ActiveRightSidebarTab
  rightSidebarExplorerView: RightSidebarExplorerView
}

/** The Files tree hides under search results; consumers that watch or decorate it treat that like the old search view. */
export function getExplorerTreeView(state: {
  rightSidebarExplorerView: RightSidebarExplorerView
  activeWorktreeId?: string | null
  fileSearchStateByWorktree?: Record<string, { active?: boolean } | undefined>
}): RightSidebarExplorerView {
  const searchState = state.activeWorktreeId
    ? state.fileSearchStateByWorktree?.[state.activeWorktreeId]
    : undefined
  return searchState?.active ? 'search' : state.rightSidebarExplorerView
}

export type NormalizeRightSidebarRouteOptions = {
  /** Drop keys only for known-uninstalled plugins, retaining disabled/unknown-during-hydration routes; render-time resolveRightSidebarEffectiveTab still guards. */
  installedPluginTabKeys?: ReadonlySet<string>
}

export function normalizeRightSidebarRoute(
  tab: unknown,
  options?: NormalizeRightSidebarRouteOptions
): RightSidebarRoute {
  // Why: older builds persisted Search as a standalone activity tab; search now lives in the Files view.
  if (tab === 'search') {
    return { rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files' }
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
    tab === 'ports' ||
    tab === 'bot-activity' ||
    tab === 'bot-automations' ||
    tab === 'bot-connectors' ||
    tab === 'bot-chats'
  ) {
    return {
      rightSidebarTab: tab,
      // Why: the Files view searches names and text together; a persisted 'search' view maps to it.
      rightSidebarExplorerView: 'files'
    }
  }
  return { rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files' }
}
