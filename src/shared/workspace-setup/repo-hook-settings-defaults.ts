import { DEFAULT_SETUP_AGENT_STARTUP_POLICY } from '../agent-launch/startup/setup-agent-startup-policy'
import type { RepoHookSettings, SetupAgentStartupPolicy } from './orca-yaml-hook-types'

export function getDefaultRepoHookSettings(): RepoHookSettings {
  return {
    mode: 'auto',
    setupRunPolicy: 'run-by-default',
    setupAgentStartupPolicy: DEFAULT_SETUP_AGENT_STARTUP_POLICY,
    scripts: {
      setup: '',
      archive: ''
    }
  }
}

export function getRepoSetupAgentStartupPolicy(repo?: {
  hookSettings?: Pick<RepoHookSettings, 'setupAgentStartupPolicy'>
}): SetupAgentStartupPolicy {
  return repo?.hookSettings?.setupAgentStartupPolicy ?? DEFAULT_SETUP_AGENT_STARTUP_POLICY
}

/** The repo's whole hook settings with a new startup policy, as repo.update replaces them. */
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
