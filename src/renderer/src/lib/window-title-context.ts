import type { AppState } from '@/store/types'
import { selectKnownWorktreeById } from '@/store/selectors'
import { translate } from '@/i18n/i18n'
import { getNotificationWorkspaceLabels } from '@/components/terminal-pane/terminal-notification-state'
import { branchDisplayName } from '@/components/sidebar/WorktreeCardHelpers'
import { isPairedWebClientWindow } from './desktop-window-chrome'
import { resolveFocusedTabAgent } from './tab-agent'
import { clearWorkingIndicators } from '../../../shared/agent-title-status'
import { resolveUnifiedTabLabel } from '../../../shared/tab-title-resolution'
import { tuiAgentDisplayName } from '../../../shared/tui-agent-display-names'
import type { TopLevelView } from '../../../shared/ui-chrome-types'
import {
  DEFAULT_WINDOW_TITLE_SEPARATOR,
  DEFAULT_WINDOW_TITLE_TEMPLATE,
  formatWindowTitle,
  normalizeWindowTitleSeparator,
  normalizeWindowTitleTemplate,
  type WindowTitleTokens
} from '../../../shared/window-title-format'

type WindowTitleState = AppState

// Reuses the sidebar and settings nav strings so the catalogs gain no duplicates.
function viewLabel(view: Exclude<TopLevelView, 'terminal'>): string {
  switch (view) {
    case 'tasks':
      return translate('auto.components.sidebar.SidebarNav.fee535205b', 'Tasks')
    case 'activity':
      return translate('auto.components.LinearIssueWorkspace.543970c87a', 'Activity')
    case 'automations':
      return translate('auto.components.sidebar.SidebarNav.f323383e9a', 'Automations')
    case 'skills':
      return translate('auto.components.sidebar.SidebarNav.skills', 'Skills')
    case 'artifacts':
      return translate('auto.components.sidebar.SidebarNav.artifacts', 'Artifacts')
    case 'space':
      return translate('auto.components.status.bar.WorkspaceSpaceCompactPanel.8ff597593d', 'Space')
    case 'mobile':
      return translate('auto.hooks.useSettingsNavigationMetadata.1cd25673df', 'Mobile')
    case 'settings':
      return translate('menu.settings', 'Settings')
  }
}

export function windowTitleAppName(): string {
  return isPairedWebClientWindow() ? 'Orca Web' : 'Orca'
}

function resolveFocusedTab(
  state: WindowTitleState,
  worktreeId: string
): { tab: string; agent: string } {
  const focusedGroupId = state.activeGroupIdByWorktree[worktreeId]
  const group = state.groupsByWorktree[worktreeId]?.find((g) => g.id === focusedGroupId)
  const tab = group?.activeTabId
    ? state.unifiedTabsByWorktree[worktreeId]?.find((t) => t.id === group.activeTabId)
    : undefined
  if (!tab) {
    return { tab: '', agent: '' }
  }
  const label = resolveUnifiedTabLabel(tab, state.settings?.tabAutoGenerateTitle === true)
  const agent =
    tab.contentType === 'terminal'
      ? resolveFocusedTabAgent(
          state.agentStatusByPaneKey,
          state.terminalLayoutsByTabId[tab.entityId],
          tab.entityId
        )
      : null
  return {
    // Agent OSC titles animate spinners; leaving them in would split tracked time per frame.
    tab: clearWorkingIndicators(label),
    agent: agent ? (tuiAgentDisplayName(agent) ?? '') : ''
  }
}

function resolveWorkspaceTokens(state: WindowTitleState): Omit<WindowTitleTokens, 'app' | 'view'> {
  const worktreeId = state.activeWorktreeId
  const row = selectKnownWorktreeById(state, worktreeId)
  if (!worktreeId || !row) {
    return {}
  }
  const { repoLabel } = getNotificationWorkspaceLabels(state, worktreeId)
  return {
    project: repoLabel,
    workspace: row.displayName || branchDisplayName(row.branch),
    branch: branchDisplayName(row.branch),
    ...resolveFocusedTab(state, worktreeId)
  }
}

/** A primitive string, so title-frame store writes that leave it unchanged never re-render the App root. */
export function selectWindowTitle(state: WindowTitleState): string {
  const app = windowTitleAppName()
  const settings = state.settings
  if (settings?.windowTitleShowWorkspace !== true) {
    return app
  }
  const template = normalizeWindowTitleTemplate(
    settings.windowTitleTemplate ?? DEFAULT_WINDOW_TITLE_TEMPLATE
  )
  const separator = normalizeWindowTitleSeparator(
    settings.windowTitleSeparator ?? DEFAULT_WINDOW_TITLE_SEPARATOR
  )
  const tokens: WindowTitleTokens =
    state.activeView === 'terminal'
      ? { app, ...resolveWorkspaceTokens(state) }
      : { app, view: viewLabel(state.activeView) }
  return formatWindowTitle({ template, separator, tokens })
}
