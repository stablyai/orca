import { agentPermissionHostPlatform, permissionEnvNameMatches } from './agent-permission-env'
import type {
  AgentLaunchSettingsMutation,
  AgentLaunchSettingsSource
} from './agent-launch-settings'
import { resolveTuiAgentLaunchEnv } from './tui-agent-launch-defaults'
import {
  agentPermissionEnv,
  applyAgentPermissionOverrides,
  hasTypedAgentPermission,
  resolveAgentPermission,
  type AgentPermissionChoice
} from './tui-agent-permission-choice'
import { liftAgentPermissionEnv } from './tui-agent-permission-lift'
import type { TuiAgent } from './tui-agent'

/** An agent's choice changed only when it differs from what it resolves to now. */
export function choiceUpdate(
  settings: AgentLaunchSettingsSource,
  agent: TuiAgent,
  choice: AgentPermissionChoice
): AgentLaunchSettingsSource {
  return resolveAgentPermission(agent, settings).choice === choice
    ? {}
    : applyAgentPermissionOverrides(settings, [agent], choice)
}

function hasEnvPermission(agent: TuiAgent): boolean {
  return Object.keys(agentPermissionEnv(agent, 'full-access')).length > 0
}

/** A whole env record as its terminal gets it; for Goose, the bypass entry is the choice. */
export function legacyEnvUpdates(
  settings: AgentLaunchSettingsSource,
  agent: TuiAgent,
  env: Record<string, string>,
  platform: NodeJS.Platform | undefined = agentPermissionHostPlatform()
): AgentLaunchSettingsSource {
  if (!hasEnvPermission(agent)) {
    return { agentDefaultEnv: { ...settings.agentDefaultEnv, [agent]: env } }
  }
  const previous = resolveTuiAgentLaunchEnv(agent, settings, platform)
  const names = Object.keys(agentPermissionEnv(agent, 'full-access'))
  const carrier = (value: Record<string, string>) =>
    Object.entries(value)
      .filter(([key]) => names.some((name) => permissionEnvNameMatches(key, name, platform)))
      .sort(([a], [b]) => a.localeCompare(b))
  if (JSON.stringify(carrier(previous)) === JSON.stringify(carrier(env))) {
    const user = { ...env }
    for (const [key] of carrier(env)) {
      delete user[key]
    }
    return {
      agentDefaultEnv: {
        ...settings.agentDefaultEnv,
        [agent]: {
          ...user,
          ...Object.fromEntries(carrier(settings.agentDefaultEnv?.[agent] ?? {}))
        }
      }
    }
  }
  const lifted = liftAgentPermissionEnv(agent, env, platform)
  return {
    agentDefaultEnv: { ...settings.agentDefaultEnv, [agent]: lifted.env },
    ...choiceUpdate(settings, agent, lifted.choice ?? 'own')
  }
}

export function agentEnvironmentMutationUpdates(
  settings: AgentLaunchSettingsSource,
  mutation: Extract<
    AgentLaunchSettingsMutation,
    { type: 'environment-set' | 'environment-remove' }
  >,
  platform: NodeJS.Platform
): AgentLaunchSettingsSource {
  // Edits the env the terminal gets, so removing Goose's published bypass entry means own.
  const env = { ...resolveTuiAgentLaunchEnv(mutation.agent, settings, platform) }
  // Windows environment names are case insensitive on the execution host.
  for (const name of Object.keys(env)) {
    if (
      name === mutation.name ||
      (platform === 'win32' && name.toLowerCase() === mutation.name.toLowerCase())
    ) {
      delete env[name]
    }
  }
  const nextEnv =
    mutation.type === 'environment-set' ? { ...env, [mutation.name]: mutation.value } : env
  if (hasTypedAgentPermission(settings)) {
    return legacyEnvUpdates(settings, mutation.agent, nextEnv, platform)
  }
  return { agentDefaultEnv: { ...settings.agentDefaultEnv, [mutation.agent]: nextEnv } }
}
