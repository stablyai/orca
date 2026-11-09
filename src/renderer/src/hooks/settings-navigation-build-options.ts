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
  /** Orca Cloud programmatic access (API keys, routines): only builds with a control plane. */
  isOrcaCloudApiAvailable?: boolean
  repos: readonly Repo[]
  projectGrouping?: ProjectGroupingModel
}
