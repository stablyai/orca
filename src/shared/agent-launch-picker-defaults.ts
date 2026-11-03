import { isAgentPermissionChoice } from './tui-agent-permission-choice'
import { projectAgentLaunchProfile } from './agent-launch-profile'
import { structuredLaunchSeedOptions } from './native-chat/input/native-chat-session-option-defaults'
import { isAgentChatPermissionChoice } from './agent-chat-permission-mode'
import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'
import type { AgentPickerEntry } from './agent-launch-picker'

export type AgentPickerDefaultSettings = Partial<
  Pick<
    GlobalSettings,
    | 'agentLaunchChoices'
    | 'agentDefaultArgs'
    | 'agentPermissionDefault'
    | 'agentPermissionOverrides'
    | 'nativeChatSessionOptions'
    | 'nativeChatPermissionMode'
  >
>

export function agentPickerChoiceSeeds(
  agent: TuiAgent,
  settings: AgentPickerDefaultSettings | null | undefined
): Pick<AgentPickerEntry, 'terminal' | 'structured' | 'arguments'> {
  const profile = projectAgentLaunchProfile(agent, settings, { target: 'structured' })
  const { model, permissionMode, ...options } = structuredLaunchSeedOptions(settings, agent) ?? {}
  return {
    terminal: profile.choices,
    structured: {
      ...(model ? { model } : {}),
      options,
      ...(isAgentChatPermissionChoice(permissionMode) ? { permissionMode } : {})
    },
    arguments: profile.args
  }
}

export function usableAgentPickerDefaultSettings(
  value: unknown
): value is AgentPickerDefaultSettings {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  const argsRecord = (value: unknown) =>
    value === undefined ||
    (record(value) && Object.values(value).every((v) => typeof v === 'string'))
  const permissionsRecord = (value: unknown) =>
    value === undefined || (record(value) && Object.values(value).every(isAgentPermissionChoice))
  return (
    record(value) &&
    argsRecord(value.agentDefaultArgs) &&
    permissionsRecord(value.agentPermissionOverrides) &&
    (value.agentPermissionDefault === undefined ||
      isAgentPermissionChoice(value.agentPermissionDefault)) &&
    (value.agentPermission === undefined ||
      (record(value.agentPermission) &&
        isAgentPermissionChoice(value.agentPermission.default) &&
        argsRecord(value.agentPermission.userArgs) &&
        permissionsRecord(value.agentPermission.overrides)))
  )
}
