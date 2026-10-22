import type { GlobalSettings } from './global-settings-types'
import {
  agentChatPermissionModes,
  type AgentChatPermissionMode
} from './agent-chat-permission-mode'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'
import { buildDefaultAgentSettingsUpdate } from './default-agent-settings'
import {
  buildAgentAvailabilitySettingsUpdate,
  normalizeDisabledTuiAgents
} from './tui-agent-selection'
import {
  normalizeTuiAgentArgsRecord,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'
import {
  applyAgentPermissionMode,
  AUTO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV,
  resolveTuiAgentPermissionMode,
  resolveAgentPermissionModeSummary,
  resolveNonAutoAgentPermissionMode,
  type AgentPermissionMode
} from './tui-agent-permissions'

export type AgentLaunchSettingsSource = Partial<
  Pick<
    GlobalSettings,
    | 'defaultTuiAgent'
    | 'newWorkspaceSetupOnly'
    | 'disabledTuiAgents'
    | 'agentCmdOverrides'
    | 'agentDefaultArgs'
    | 'agentDefaultEnv'
    | 'nativeChatPermissionMode'
    | 'agentNativeChatPermissionModes'
  >
>

export type AgentLaunchSettings = {
  defaultTuiAgent: GlobalSettings['defaultTuiAgent']
  newWorkspaceSetupOnly?: boolean
  disabledTuiAgents: TuiAgent[]
  agentCmdOverrides: NonNullable<GlobalSettings['agentCmdOverrides']>
  agentDefaultArgs: NonNullable<GlobalSettings['agentDefaultArgs']>
  environmentNames: Partial<Record<TuiAgent, string[]>>
  permissionMode: Exclude<AgentPermissionMode, 'auto'>
  autoPermissionMode?: true
  /** With Auto on: the combined mode of agents Auto doesn't cover. Absent from older hosts. */
  nonAutoPermissionMode?: 'manual' | 'yolo' | 'mixed'
}

export type AgentLaunchSettingsMutation =
  | { type: 'default'; agent: GlobalSettings['defaultTuiAgent']; setupOnly?: boolean }
  | { type: 'availability'; agent: TuiAgent; enabled: boolean }
  | {
      type: 'permissions'
      mode: Exclude<AgentPermissionMode, 'mixed'>
      agent?: TuiAgent
      /** Change only agents Auto doesn't cover. Sent only to hosts with the Auto capability. */
      exceptAuto?: true
      syncNativeChat?: true
    }
  | { type: 'command'; agent: TuiAgent; value: string }
  | { type: 'arguments'; agent: TuiAgent; value: string }
  | { type: 'environment-set'; agent: TuiAgent; name: string; value: string }
  | { type: 'environment-remove'; agent: TuiAgent; name: string }

export function projectAgentLaunchSettings(
  settings: AgentLaunchSettingsSource
): AgentLaunchSettings {
  const permissionMode = resolveAgentPermissionModeSummary(settings)
  return {
    defaultTuiAgent: settings.defaultTuiAgent ?? null,
    newWorkspaceSetupOnly: false,
    disabledTuiAgents: normalizeDisabledTuiAgents(settings.disabledTuiAgents),
    agentCmdOverrides: { ...settings.agentCmdOverrides },
    agentDefaultArgs: normalizeTuiAgentArgsRecord(settings.agentDefaultArgs),
    environmentNames: Object.fromEntries(
      Object.entries(settings.agentDefaultEnv ?? {}).map(([agent, env]) => [
        agent,
        Object.keys(env ?? {}).sort()
      ])
    ),
    // Older clients understand Mixed and ignore the optional automatic-mode marker.
    permissionMode: permissionMode === 'auto' ? 'mixed' : permissionMode,
    ...(permissionMode === 'auto'
      ? {
          autoPermissionMode: true,
          nonAutoPermissionMode: resolveNonAutoAgentPermissionMode(settings)
        }
      : {})
  }
}

function nativeChatModesForPreset(
  settings: AgentLaunchSettingsSource,
  mode: AgentChatPermissionMode,
  autoOnly: boolean
): Partial<Record<TuiAgent, AgentChatPermissionMode>> {
  return Object.fromEntries(
    [...Object.keys(YOLO_TUI_AGENT_ARGS), ...Object.keys(YOLO_TUI_AGENT_ENV)]
      .filter((agent): agent is TuiAgent => isTuiAgent(agent))
      .filter(
        (agent) =>
          agent in AUTO_TUI_AGENT_ARGS === autoOnly &&
          agentChatPermissionModes(agent) &&
          resolveTuiAgentPermissionMode({
            agent,
            agentArgs: resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
            agentEnv: resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv)
          }) !== 'mixed'
      )
      .map((agent) => [agent, mode])
  )
}

export function agentLaunchSettingsMutationUpdates(
  settings: AgentLaunchSettingsSource,
  mutation: AgentLaunchSettingsMutation,
  platform: NodeJS.Platform
): AgentLaunchSettingsSource {
  switch (mutation.type) {
    case 'default':
      return buildDefaultAgentSettingsUpdate(mutation.agent)
    case 'availability':
      return buildAgentAvailabilitySettingsUpdate(
        {
          defaultTuiAgent: settings.defaultTuiAgent ?? null,
          disabledTuiAgents: settings.disabledTuiAgents ?? []
        },
        mutation.agent,
        mutation.enabled
      )
    case 'permissions': {
      const nativeMode =
        mutation.mode === 'yolo' ? 'full-access' : mutation.mode === 'auto' ? 'auto' : 'ask'
      if (mutation.agent) {
        const agent = mutation.agent
        if (!(agent in YOLO_TUI_AGENT_ARGS) && !(agent in YOLO_TUI_AGENT_ENV)) {
          throw new Error('This agent has no configurable terminal permission mode')
        }
        if (mutation.mode === 'auto' && !AUTO_TUI_AGENT_ARGS[agent]) {
          throw new Error('This agent does not support automatic permission review')
        }
        if (
          resolveTuiAgentPermissionMode({
            agent,
            agentArgs: resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
            agentEnv: resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv)
          }) === 'mixed'
        ) {
          throw new Error('Edit custom launch arguments before choosing a permission mode')
        }
        return {
          ...applyAgentPermissionMode({ ...settings, mode: mutation.mode, agent }),
          ...(mutation.syncNativeChat && agentChatPermissionModes(agent)
            ? {
                agentNativeChatPermissionModes: {
                  ...settings.agentNativeChatPermissionModes,
                  [agent]: nativeMode
                }
              }
            : {})
        }
      }
      if (mutation.exceptAuto) {
        if (mutation.mode === 'auto') {
          throw new Error('Auto cannot apply to agents without automatic permission review')
        }
        return {
          ...applyAgentPermissionMode({ ...settings, mode: mutation.mode, exceptAuto: true }),
          ...(mutation.syncNativeChat
            ? {
                agentNativeChatPermissionModes: {
                  ...settings.agentNativeChatPermissionModes,
                  ...nativeChatModesForPreset(settings, nativeMode, false)
                }
              }
            : {})
        }
      }
      if (mutation.mode === 'auto') {
        return {
          ...applyAgentPermissionMode({ ...settings, mode: mutation.mode }),
          ...(mutation.syncNativeChat
            ? {
                agentNativeChatPermissionModes: {
                  ...settings.agentNativeChatPermissionModes,
                  ...nativeChatModesForPreset(settings, nativeMode, true)
                }
              }
            : {})
        }
      }
      return {
        ...applyAgentPermissionMode({ ...settings, mode: mutation.mode }),
        ...(mutation.syncNativeChat
          ? { nativeChatPermissionMode: nativeMode, agentNativeChatPermissionModes: {} }
          : {})
      }
    }
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
