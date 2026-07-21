export type CliInstallState = 'installed' | 'not_installed' | 'stale' | 'conflict' | 'unsupported'

export type CliInstallUnsupportedReason =
  | 'platform_not_supported'
  | 'launcher_missing'
  | 'launch_mode_unavailable'

export type CliInstallMethod = 'symlink' | 'wrapper'

export type CliInstallStatus = {
  platform: NodeJS.Platform
  commandName: string
  commandPath: string | null
  pathDirectory: string | null
  /** Null means the persisted PATH could not be read, so callers must not offer a mutation. */
  pathConfigured: boolean | null
  launcherPath: string | null
  installMethod: CliInstallMethod | null
  supported: boolean
  state: CliInstallState
  currentTarget: string | null
  unsupportedReason: CliInstallUnsupportedReason | null
  detail: string | null
}
