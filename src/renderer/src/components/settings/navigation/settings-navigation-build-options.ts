import type { ProjectGroupSettingsEntry } from '../repository/hooks/use-supported-group-hook-settings'
import type { ProjectGroupingModel } from '../../../../../shared/sidebar-list/sections/project-section-grouping'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Bot } from '../../../../../shared/bot-types'
import type { OptInOnlyExperimentVisibility } from '../advanced/experimental-search'

export type SettingsNavigationBuildOptions = {
  isMac: boolean
  isWindows: boolean
  isLocalWindowsHost: boolean
  isWindowsTerminalHost: boolean
  isWebClient: boolean
  /** Settings › Bots › Enable bots. */
  botsEnabled: boolean
  hostQueuesMessages: boolean
  typedChatPermissions?: boolean
  managedBrowserCreationEnabled: boolean
  mobileEmulatorCreationEnabled: boolean
  showWorkspaceCardLayout: boolean
  isDev: boolean
  /** Opt-in-only experiments stay searchable only while the user has them on. */
  optInOnlyExperiments: OptInOnlyExperimentVisibility
  isLinearConnected: boolean
  /** This computer or the default host serves `mcpServers.*`. */
  mcpServersAvailable?: boolean
  projectGroups?: readonly ProjectGroupSettingsEntry[]
  repos: readonly Repo[]
  bots: readonly Bot[]
  projectGrouping?: ProjectGroupingModel
}
