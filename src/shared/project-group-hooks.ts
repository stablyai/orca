import type { OrcaHooks, RepoHookSettings, SetupRunPolicy } from './orca-yaml-hook-types'
import type { SetupConfig } from './orca-hook-setup-config'
export type GroupHookCheckResult = {
  status?: 'ok' | 'error'
  hasHooks: boolean
  hooks: OrcaHooks | null
  mayNeedUpdate: boolean
  unavailable?: 'wsl-distro-stopped' | 'wsl-distro-unverifiable'
  hookSettings?: RepoHookSettings
  setupRunPolicy: SetupRunPolicy
  setupConfig: SetupConfig | null
}
