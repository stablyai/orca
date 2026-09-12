import type { GlobalSettings } from '../../../../../../shared/global-settings-types'

export type GitRuntimeOperationOptions = {
  runtimeTargetSettings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  applyUpstreamStatus?: boolean
}
