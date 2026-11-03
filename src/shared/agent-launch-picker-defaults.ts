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
