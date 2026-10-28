import type { GlobalSettings } from './global-settings-types'
import { resolvedTuiAgentArgsBypassPermissions } from './tui-agent-launch-defaults'
import { YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import {
  hasTypedAgentPermission,
  resolveAgentPermission,
  type AgentPermissionSettings
} from './tui-agent-permission-choice'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

/** A chat's own permission choice. Saved in chat records and settings: never rename a value. */
export type AgentChatPermissionChoice = 'own' | AgentChatPermissionMode

export type AgentChatPermissionMode = 'ask' | 'accept-edits' | 'auto' | 'full-access'

export function isAgentChatPermissionChoice(value: unknown): value is AgentChatPermissionChoice {
  return value === 'own' || isAgentChatPermissionMode(value)
}

/** Picker order: least to most access. */
export const AGENT_CHAT_PERMISSION_MODES = [
  'ask',
  'accept-edits',
  'auto',
  'full-access'
] as const satisfies readonly AgentChatPermissionMode[]

/** Desktop/mobile resolve these lucide names through their own icon packages. */
export const AGENT_CHAT_PERMISSION_MODE_ICON_NAMES = {
  ask: 'Hand',
  'accept-edits': 'FilePenLine',
  auto: 'ShieldCheck',
  'full-access': 'ShieldAlert'
} as const satisfies Record<AgentChatPermissionMode, string>

export type AgentChatPermissionModeIconName =
  (typeof AGENT_CHAT_PERMISSION_MODE_ICON_NAMES)[AgentChatPermissionMode]

export const AGENT_CHAT_PERMISSION_MODE_OPTION_ID = 'permissionMode'

export function isAgentChatPermissionMode(value: unknown): value is AgentChatPermissionMode {
  return AGENT_CHAT_PERMISSION_MODES.some((mode) => mode === value)
}

import {
  agentChatPermissionModes,
  type AgentChatPermissionModeSupport
} from './agent-chat-permission-support'
export {
  agentChatPermissionModes,
  type AgentChatPermissionModeSupport
} from './agent-chat-permission-support'

/** The saved choice if this agent offers it; anything else asks, never grants more access. */
export function savedChatPermissionMode(
  support: AgentChatPermissionModeSupport,
  intent: AgentChatPermissionMode
): AgentChatPermissionMode
export function savedChatPermissionMode(
  support: AgentChatPermissionModeSupport,
  intent: unknown
): AgentChatPermissionChoice
export function savedChatPermissionMode(
  support: AgentChatPermissionModeSupport,
  intent: unknown
): AgentChatPermissionChoice {
  if (intent === 'own') {
    return 'own'
  }
  return support.modes.find((mode) => mode === intent) ?? 'ask'
}

export function newChatPermissionMode(
  agent: string,
  setting: unknown
): AgentChatPermissionChoice | null {
  const support = agentChatPermissionModes(agent)
  return support ? savedChatPermissionMode(support, setting) : null
}

export type NewChatPermissionSettings = AgentPermissionSettings &
  Partial<Pick<GlobalSettings, 'nativeChatPermissionMode'>>

/** The four-mode value shipped clients understand; delegation has no legacy representation. */
export function publishedLegacyChatPermissionMode(
  settings: NewChatPermissionSettings
): AgentChatPermissionMode {
  const choice = hasTypedAgentPermission(settings)
    ? settings.agentPermissionDefault
    : settings.nativeChatPermissionMode
  return isAgentChatPermissionMode(choice) ? choice : 'ask'
}

/** New chats use the same permission as the agent's terminals. */
export function newChatPermissionModeForSettings(
  agent: string,
  settings: NewChatPermissionSettings | null | undefined
): AgentChatPermissionChoice | null {
  const support = agentChatPermissionModes(agent)
  if (support && isTuiAgent(agent) && hasTypedAgentPermission(settings)) {
    return savedChatPermissionMode(support, resolveAgentPermission(agent, settings).choice)
  }
  return newChatPermissionMode(agent, settings?.nativeChatPermissionMode)
}

/** Pre-mode chats inherit argument bypass as Full access; agents without bypass use the new-chat setting. */
export function preModeChatGetsFullAccess(
  agent: TuiAgent,
  settings: AgentPermissionSettings &
    Partial<
      Pick<GlobalSettings, 'agentDefaultArgs' | 'terminalWindowsShell' | 'nativeChatPermissionMode'>
    >,
  platform: NodeJS.Platform
): boolean {
  return agent in YOLO_TUI_AGENT_ARGS
    ? resolvedTuiAgentArgsBypassPermissions(agent, settings, platform)
    : settings.nativeChatPermissionMode === 'full-access'
}
