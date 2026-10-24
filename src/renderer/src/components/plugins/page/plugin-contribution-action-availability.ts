import type { PluginHostListEntry } from '../../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import type { AppState } from '@/store/types'

/** Only these statuses back the Adds rows with Orca's live registrations, so a "try it" does what it says. */
export function isPluginContributionLive(
  plugin: PluginHostListEntry | null
): plugin is PluginHostListEntry {
  return (
    plugin?.status === 'running' || plugin?.status === 'idle' || plugin?.status === 'restarting'
  )
}

export function pluginCommandUnavailableReason(
  command: { context: 'global' | 'worktree' },
  activeWorktreeId: string | null
): string | null {
  if (command.context === 'worktree' && !activeWorktreeId) {
    return translate(
      'auto.components.settings.PluginContributionActionCommand.needsWorkspace',
      'Open a workspace to run it.'
    )
  }
  return null
}

/** The right sidebar paints only over an open workspace, so leaving Settings must land on one. */
export function pluginPanelUnavailableReason(
  state: Pick<AppState, 'previousViewBeforeSettings' | 'activeWorktreeId'>
): string | null {
  if (!canShowRightSidebarForView(state.previousViewBeforeSettings) || !state.activeWorktreeId) {
    return translate(
      'auto.components.settings.PluginContributionActionPanel.needsWorkspace',
      'Open a workspace to see it.'
    )
  }
  return null
}
