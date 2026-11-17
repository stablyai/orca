import type { ProjectGroupSettingsEntry } from '../repository/hooks/use-supported-group-hook-settings'
import type { ProjectGroupingModel } from '../../../../../shared/sidebar-list/sections/project-section-grouping'
import type { Repo } from '../../../../../shared/repository/repo-types'

export type SettingsNavigationBuildOptions = {
  isMac: boolean
  isWindows: boolean
  isLocalWindowsHost: boolean
  isWindowsTerminalHost: boolean
  isWebClient: boolean
  hostQueuesMessages: boolean
  typedChatPermissions?: boolean
  managedBrowserCreationEnabled: boolean
  mobileEmulatorCreationEnabled: boolean
  isDev: boolean
  isLinearConnected: boolean
  /** Orca Cloud programmatic access (API keys, routines): only builds with a control plane. */
  isOrcaCloudApiAvailable?: boolean
  /** Owner or admin of the active Orca team: Settings › Cloud workspaces is theirs alone. */
  isOrcaTeamAdmin?: boolean
  projectGroups?: readonly ProjectGroupSettingsEntry[]
  repos: readonly Repo[]
  projectGrouping?: ProjectGroupingModel
}
