import { resolveLocalWindowsAgentStartupShell } from './windows-terminal-shell'
import { resolveStartupShell } from './tui-agent-startup-shell'
import { agentPermissionHostPlatform } from './agent-permission-env'
import { isTuiAgent } from './tui-agent-config'
import { agentLaunchChoiceUpdates } from './agent-launch-choice-updates'
import { projectAgentLaunchProfile } from './agent-launch-profile'
import type { AgentLaunchChoices, AgentChoicePatch } from './agent-launch-choices'
import { agentEnvironmentMutationUpdates, choiceUpdate } from './agent-launch-environment-updates'
import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'
import { buildDefaultAgentSettingsUpdate } from './default-agent-settings'
import {
  buildAgentAvailabilitySettingsUpdate,
  normalizeDisabledTuiAgents
} from './tui-agent-selection'
import {
  composeAgentLaunchProfile,
  normalizeTuiAgentArgsRecord,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'
import { hasTypedAgentPermission, type AgentPermissionChoice } from './tui-agent-permission-choice'
import { liftAgentPermissionArgs } from './tui-agent-permission-lift'
import {
  legacyArgumentsUpdates,
  legacyPermissionsUpdates,
  permissionUpdates
} from './agent-launch-permission-updates'
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
    | 'agentLaunchChoices'
    | 'agentDefaultArgs'
    | 'agentDefaultEnv'
    | 'agentPermissionDefault'
    | 'agentPermissionOverrides'
    | 'nativeChatPermissionMode'
    | 'terminalWindowsShell'
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
  /** Stored permission and user Arguments exclude Orca flags; agentDefaultArgs retains them for older clients. Absent on hosts storing permissions as text. */
  agentChoices?: { defaults: AgentLaunchChoices; userArgs: Partial<Record<TuiAgent, string>> }
  agentPermission?: {
    default: AgentPermissionChoice
    overrides: Partial<Record<TuiAgent, AgentPermissionChoice>>
    userArgs: Partial<Record<TuiAgent, string>>
  }
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
      /** Accepted from legacy clients; the single permission choice already drives chats. */
      syncNativeChat?: true
    }
  /** Hosts with the stored permission. No agent: all agents; `withoutAuto`: agents without Auto. */
  | {
      type: 'permission'
      choice: AgentPermissionChoice | 'default'
      agent?: TuiAgent
      withoutAuto?: true
    }
  | { type: 'command'; agent: TuiAgent; value: string }
  /** The whole terminal text, flag included, as older clients see it. */
  | { type: 'arguments'; agent: TuiAgent; value: string }
  /** Only the user's own text; a permission flag Orca recognizes in it becomes the choice. */
  | { type: 'user-arguments'; agent: TuiAgent; value: string }
  | { type: 'launch-choices'; agent: TuiAgent; patch?: AgentChoicePatch; userArgs?: string }
  | { type: 'environment-set'; agent: TuiAgent; name: string; value: string }
  | { type: 'environment-remove'; agent: TuiAgent; name: string }

export function projectAgentLaunchSettings(
  settings: AgentLaunchSettingsSource,
  platform?: NodeJS.Platform
): AgentLaunchSettings {
  const hostPlatform = platform ?? agentPermissionHostPlatform()
  const shell = resolveStartupShell(
    hostPlatform,
    resolveLocalWindowsAgentStartupShell({
      platform: hostPlatform,
      isRemote: false,
      terminalWindowsShell: settings.terminalWindowsShell
    })
  )
  const composed = composeAgentLaunchProfile(settings, hostPlatform)
  const permissionMode = resolveAgentPermissionModeSummary(composed)
  return {
    defaultTuiAgent: settings.defaultTuiAgent ?? null,
    newWorkspaceSetupOnly: false,
    disabledTuiAgents: normalizeDisabledTuiAgents(settings.disabledTuiAgents),
    agentCmdOverrides: { ...settings.agentCmdOverrides },
    agentDefaultArgs: normalizeTuiAgentArgsRecord(composed.agentDefaultArgs),
    environmentNames: Object.fromEntries(
      Object.entries(composed.agentDefaultEnv).map(([agent, env]) => [
        agent,
        Object.keys(env ?? {}).sort()
      ])
    ),
    // Older clients understand Mixed and ignore the optional automatic-mode marker.
    permissionMode: permissionMode === 'auto' ? 'mixed' : permissionMode,
    ...(permissionMode === 'auto'
      ? {
          autoPermissionMode: true,
          nonAutoPermissionMode: resolveNonAutoAgentPermissionMode(composed)
        }
      : {}),
    ...(settings.agentLaunchChoices !== undefined
      ? {
          agentChoices: {
            defaults: settings.agentLaunchChoices,
            userArgs: normalizeTuiAgentArgsRecord(settings.agentDefaultArgs)
          }
        }
      : {}),
    ...(hasTypedAgentPermission(settings)
      ? {
          agentPermission: {
            default: settings.agentPermissionDefault ?? 'own',
            overrides: { ...settings.agentPermissionOverrides },
            userArgs: Object.fromEntries(
              Object.keys(composed.agentDefaultArgs)
                .filter(isTuiAgent)
                .map((agent) => [
                  agent,
                  projectAgentLaunchProfile(agent, settings, { target: 'legacy-permission', shell })
                    .args
                ])
            )
          }
        }
      : {})
  }
}

export function agentLaunchSettingsMutationUpdates(
  settings: AgentLaunchSettingsSource,
  mutation: AgentLaunchSettingsMutation,
  platform: NodeJS.Platform
): AgentLaunchSettingsSource {
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: settings.terminalWindowsShell
    })
  )
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
    case 'permission':
      if (!hasTypedAgentPermission(settings)) {
        throw new Error('This host stores permissions in launch arguments')
      }
      return permissionUpdates(settings, mutation)
    case 'permissions': {
      const typed = hasTypedAgentPermission(settings)
      const terminal = (args: Parameters<typeof applyAgentPermissionMode>[0]) =>
        typed ? legacyPermissionsUpdates(settings, mutation) : applyAgentPermissionMode(args)
      if (mutation.agent) {
        const agent = mutation.agent
        if (!(agent in YOLO_TUI_AGENT_ARGS) && !(agent in YOLO_TUI_AGENT_ENV)) {
          throw new Error('This agent has no configurable terminal permission mode')
        }
        if (mutation.mode === 'auto' && !AUTO_TUI_AGENT_ARGS[agent]) {
          throw new Error('This agent does not support automatic permission review')
        }
        if (
          !typed &&
          resolveTuiAgentPermissionMode({
            agent,
            agentArgs: resolveTuiAgentLaunchArgs(agent, settings),
            agentEnv: resolveTuiAgentLaunchEnv(agent, settings)
          }) === 'mixed'
        ) {
          throw new Error('Edit custom launch arguments before choosing a permission mode')
        }
        return terminal({ ...settings, mode: mutation.mode, agent })
      }
      if (mutation.exceptAuto && mutation.mode === 'auto') {
        throw new Error('Auto cannot apply to agents without automatic permission review')
      }
      return terminal({
        ...settings,
        mode: mutation.mode,
        ...(mutation.exceptAuto ? { exceptAuto: true } : {})
      })
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
    case 'launch-choices':
      return agentLaunchChoiceUpdates(settings, mutation.agent, mutation)
    case 'arguments':
      if (settings.agentLaunchChoices !== undefined) {
        return agentLaunchChoiceUpdates(
          settings,
          mutation.agent,
          { userArgs: mutation.value },
          { target: 'terminal', shell }
        )
      }
      if (hasTypedAgentPermission(settings)) {
        return legacyArgumentsUpdates(settings, mutation.agent, mutation.value, platform)
      }
      return {
        agentDefaultArgs: normalizeTuiAgentArgsRecord({
          ...settings.agentDefaultArgs,
          [mutation.agent]: mutation.value
        })
      }
    case 'user-arguments': {
      if (settings.agentLaunchChoices !== undefined) {
        return agentLaunchChoiceUpdates(
          settings,
          mutation.agent,
          { userArgs: mutation.value },
          { target: 'legacy-permission', shell }
        )
      }
      if (!hasTypedAgentPermission(settings)) {
        throw new Error('This host stores permissions in launch arguments')
      }
      const lifted = liftAgentPermissionArgs(mutation.agent, mutation.value)
      return {
        agentDefaultArgs: normalizeTuiAgentArgsRecord({
          ...settings.agentDefaultArgs,
          [mutation.agent]: lifted.args
        }),
        ...(lifted.choice ? choiceUpdate(settings, mutation.agent, lifted.choice) : {})
      }
    }
    case 'environment-set':
    case 'environment-remove':
      return agentEnvironmentMutationUpdates(settings, mutation, platform)
  }
}
