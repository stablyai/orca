import type { ProjectGroupSettingsEntry } from '../repository/hooks/use-supported-group-hook-settings'
import type { ProjectGroupingModel } from '../../../../../shared/sidebar-list/sections/project-section-grouping'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Bot } from '../../../../../shared/bot-types'

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
  isDev: boolean
  isLinearConnected: boolean
  /** This computer or the default host serves `mcpServers.*`. */
  mcpServersAvailable?: boolean
  projectGroups?: readonly ProjectGroupSettingsEntry[]
  repos: readonly Repo[]
  bots: readonly Bot[]
  projectGrouping?: ProjectGroupingModel
}
