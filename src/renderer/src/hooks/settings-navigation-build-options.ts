import type { ProjectGroupSettingsEntry } from './use-supported-group-hook-settings'
import type { ProjectGroupingModel } from '../../../shared/project-section-grouping'
import type { Repo } from '../../../shared/repo-types'

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
  projectGroups?: readonly ProjectGroupSettingsEntry[]
  repos: readonly Repo[]
  projectGrouping?: ProjectGroupingModel
}
