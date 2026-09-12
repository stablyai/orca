import { getDefaultRepoHookSettings } from '../../../../shared/constants'
import type {
  RepoHookSettings,
  SetupAgentStartupPolicy
} from '../../../../shared/orca-yaml-hook-types'

export function getRepoSetupAgentStartupPolicy(repo?: {
  hookSettings?: Pick<RepoHookSettings, 'setupAgentStartupPolicy'>
}): SetupAgentStartupPolicy {
  return repo?.hookSettings?.setupAgentStartupPolicy ?? 'start-immediately'
}

export function buildSetupAgentStartupHookSettings(
  current: RepoHookSettings | undefined,
  setupAgentStartupPolicy: SetupAgentStartupPolicy
): RepoHookSettings {
  const defaults = getDefaultRepoHookSettings()
  return {
    ...defaults,
    ...current,
    setupRunPolicy: current?.setupRunPolicy ?? defaults.setupRunPolicy,
    setupAgentStartupPolicy,
    scripts: {
      ...defaults.scripts,
      ...current?.scripts
    }
  }
}
