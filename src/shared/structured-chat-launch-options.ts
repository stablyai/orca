import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatLaunchPermissionMode,
  agentChatPermissionModes
} from './agent-chat-permission-mode'
import {
  parseStructuredLaunchSeedOptions,
  resolveStructuredLaunchSeedOptions
} from './native-chat-session-option-defaults'

/** The wire already encodes Fast; reviewer intent stays with the execution host. */
export function normalizeStructuredChatLaunchOptions(
  agent: string,
  options: Readonly<Record<string, unknown>>
): Record<string, string> {
  const { permissionMode: _permissionMode, ...seeded } =
    parseStructuredLaunchSeedOptions(options) ?? {}
  return agentChatPermissionModes(agent)
    ? {
        ...seeded,
        [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: agentChatLaunchPermissionMode(
          agent,
          null,
          options[AGENT_CHAT_PERMISSION_MODE_OPTION_ID]
        )
      }
    : seeded
}

/** The client resolves once, then its draft and create share the same encoded choices. */
export function resolveStructuredChatLaunchOptions(
  settings:
    | Partial<Pick<GlobalSettings, 'nativeChatSessionOptions' | 'nativeChatPermissionMode'>>
    | null
    | undefined,
  agent: TuiAgent
): Record<string, string> {
  return normalizeStructuredChatLaunchOptions(agent, {
    ...resolveStructuredLaunchSeedOptions(settings?.nativeChatSessionOptions, agent),
    [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: settings?.nativeChatPermissionMode ?? 'bypass'
  })
}

/** Changing models retires picks made under the previous model, as the composer does. */
export function mergeStructuredChatLaunchOptions(
  seed: Readonly<Record<string, string>>,
  held: Readonly<Record<string, string>>
): Record<string, string> {
  const { model, effort: _effort, fastMode: _fastMode, ...chatOptions } = seed
  return held.model !== undefined && held.model !== model
    ? { ...chatOptions, ...held }
    : { ...seed, ...held }
}
