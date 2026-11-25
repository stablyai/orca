import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../../shared/execution-host/project-execution-runtime'

export function getProjectRuntimeShellMenuMode(
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): 'host' | 'wsl' | null {
  if (!projectRuntime) {
    return null
  }
  if (projectRuntime.status === 'repair-required') {
    return 'wsl'
  }
  return projectRuntime.runtime.kind === 'wsl' ? 'wsl' : 'host'
}

export function resolveWindowsPowerShellImplementationSetting(settings: GlobalSettings | null) {
  return settings?.terminalWindowsPowerShellImplementation ?? 'auto'
}
