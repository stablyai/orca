import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'
import {
  buildAgentAvailabilitySettingsUpdate,
  normalizeDisabledTuiAgents
} from './tui-agent-selection'
import { normalizeTuiAgentArgsRecord, resolveTuiAgentLaunchEnv } from './tui-agent-launch-defaults'
import {
  applyAgentPermissionMode,
  resolveAgentPermissionModeSummary,
  type AgentPermissionMode
} from './tui-agent-permissions'

export type AgentLaunchSettingsSource = Partial<
  Pick<
    GlobalSettings,
    | 'defaultTuiAgent'
    | 'disabledTuiAgents'
    | 'agentCmdOverrides'
    | 'agentDefaultArgs'
    | 'agentDefaultEnv'
  >
>

export type AgentLaunchSettings = {
  defaultTuiAgent: GlobalSettings['defaultTuiAgent']
  disabledTuiAgents: TuiAgent[]
  agentCmdOverrides: NonNullable<GlobalSettings['agentCmdOverrides']>
  agentDefaultArgs: NonNullable<GlobalSettings['agentDefaultArgs']>
  environmentNames: Partial<Record<TuiAgent, string[]>>
  permissionMode: AgentPermissionMode
}

export type AgentLaunchSettingsMutation =
  | { type: 'default'; agent: GlobalSettings['defaultTuiAgent'] }
  | { type: 'availability'; agent: TuiAgent; enabled: boolean }
  | { type: 'permissions'; mode: Exclude<AgentPermissionMode, 'mixed'> }
  | { type: 'command'; agent: TuiAgent; value: string }
  | { type: 'arguments'; agent: TuiAgent; value: string }
  | { type: 'environment-set'; agent: TuiAgent; name: string; value: string }
  | { type: 'environment-remove'; agent: TuiAgent; name: string }

export function projectAgentLaunchSettings(
  settings: AgentLaunchSettingsSource
): AgentLaunchSettings {
  return {
    defaultTuiAgent: settings.defaultTuiAgent ?? null,
    disabledTuiAgents: normalizeDisabledTuiAgents(settings.disabledTuiAgents),
    agentCmdOverrides: { ...settings.agentCmdOverrides },
    agentDefaultArgs: normalizeTuiAgentArgsRecord(settings.agentDefaultArgs),
    environmentNames: Object.fromEntries(
      Object.entries(settings.agentDefaultEnv ?? {}).map(([agent, env]) => [
        agent,
        Object.keys(env ?? {}).sort()
      ])
    ),
    permissionMode: resolveAgentPermissionModeSummary(settings)
  }
}

export function agentLaunchSettingsMutationUpdates(
  settings: AgentLaunchSettingsSource,
  mutation: AgentLaunchSettingsMutation,
  platform: NodeJS.Platform
): AgentLaunchSettingsSource {
  switch (mutation.type) {
    case 'default':
      return { defaultTuiAgent: mutation.agent }
    case 'availability':
      return buildAgentAvailabilitySettingsUpdate(
        {
          defaultTuiAgent: settings.defaultTuiAgent ?? null,
          disabledTuiAgents: settings.disabledTuiAgents ?? []
        },
        mutation.agent,
        mutation.enabled
      )
    case 'permissions':
      return applyAgentPermissionMode({ ...settings, mode: mutation.mode })
    case 'command': {
      const commands = { ...settings.agentCmdOverrides }
      if (mutation.value.trim()) {
        commands[mutation.agent] = mutation.value.trim()
      } else {
        delete commands[mutation.agent]
      }
      return { agentCmdOverrides: commands }
    }
    case 'arguments':
      return {
        agentDefaultArgs: normalizeTuiAgentArgsRecord({
          ...settings.agentDefaultArgs,
          [mutation.agent]: mutation.value
        })
      }
    case 'environment-set':
    case 'environment-remove': {
      const env = { ...resolveTuiAgentLaunchEnv(mutation.agent, settings.agentDefaultEnv) }
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
      return { agentDefaultEnv: { ...settings.agentDefaultEnv, [mutation.agent]: nextEnv } }
    }
  }
}
