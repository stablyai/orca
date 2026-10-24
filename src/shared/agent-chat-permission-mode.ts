import type { GlobalSettings } from './global-settings-types'
import {
  resolvedTuiAgentArgsBypassPermissions,
  resolveTuiAgentLaunchArgs
} from './tui-agent-launch-defaults'
import { AUTO_TUI_AGENT_ARGS, YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import {
  hasTypedAgentPermission,
  resolveAgentPermission,
  type AgentPermissionSettings
} from './tui-agent-permission-choice'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

/** A chat's own permission choice. Saved in chat records and settings: never rename a value. */
export type AgentChatPermissionMode = 'ask' | 'accept-edits' | 'auto' | 'full-access'

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
  intent: unknown
): AgentChatPermissionMode {
  return support.modes.find((mode) => mode === intent) ?? 'ask'
}

/** Launch and menu share model auto support: use its listed row, or the listed CLI default when unnamed. */
export function chatModelSupportsAutoMode(
  models: readonly { id: string; isDefault?: boolean; supportsAutoMode?: boolean }[],
  model: string | null | undefined
): boolean {
  const row = models.find((entry) =>
    model === undefined || model === null || model === 'default'
      ? entry.isDefault === true
      : entry.id === model
  )
  return row?.supportsAutoMode === true
}

export function chatPermissionModeNeedsModelSupport(
  support: AgentChatPermissionModeSupport,
  intent: unknown
): boolean {
  return (
    support.autoNeedsModelSupport === true && savedChatPermissionMode(support, intent) === 'auto'
  )
}

/** Saved choice, with `auto` on a model not listed for it read as Ask; never written back. */
export function effectiveChatPermissionMode(
  support: AgentChatPermissionModeSupport,
  intent: unknown,
  autoSupported: boolean
): AgentChatPermissionMode {
  const mode = savedChatPermissionMode(support, intent)
  return mode === 'auto' && support.autoNeedsModelSupport && !autoSupported ? 'ask' : mode
}

export function offeredChatPermissionModes(
  support: AgentChatPermissionModeSupport,
  autoSupported: boolean
): readonly AgentChatPermissionMode[] {
  return support.autoNeedsModelSupport && !autoSupported
    ? support.modes.filter((mode) => mode !== 'auto')
    : support.modes
}

export function newChatPermissionMode(
  agent: string,
  setting: unknown
): AgentChatPermissionMode | null {
  const support = agentChatPermissionModes(agent)
  return support ? savedChatPermissionMode(support, setting) : null
}

export type NewChatPermissionSettings = AgentPermissionSettings &
  Partial<Pick<GlobalSettings, 'nativeChatPermissionMode' | 'agentNativeChatPermissionModes'>>

/** New chats inherit agent permissions; own-settings mode retains Chat defaults until chats can run agent config. */
export function newChatPermissionModeForSettings(
  agent: string,
  settings: NewChatPermissionSettings | null | undefined
): AgentChatPermissionMode | null {
  const support = agentChatPermissionModes(agent)
  if (support && isTuiAgent(agent) && hasTypedAgentPermission(settings)) {
    const { choice } = resolveAgentPermission(agent, settings)
    if (choice !== 'own') {
      return savedChatPermissionMode(support, choice)
    }
  }
  const overrides = settings?.agentNativeChatPermissionModes
  const override = overrides && Object.getOwnPropertyDescriptor(overrides, agent)?.value
  return newChatPermissionMode(agent, override ?? settings?.nativeChatPermissionMode)
}

export function normalizeAgentNativeChatPermissionModes(
  value: unknown
): NonNullable<GlobalSettings['agentNativeChatPermissionModes']> {
  if (!value || typeof value !== 'object') {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).filter(([agent, mode]) =>
      agentChatPermissionModes(agent)?.modes.some((offered) => offered === mode)
    )
  )
}

/** Seeded once when absent, then stored; an unknown value asks. */
export function loadedChatPermissionSetting(
  saved: unknown,
  terminal: Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'terminalWindowsShell'>>,
  platform: NodeJS.Platform
): AgentChatPermissionMode {
  if (saved !== undefined) {
    return isAgentChatPermissionMode(saved) ? saved : 'ask'
  }
  const automatic = (agent: 'claude' | 'codex'): boolean =>
    resolveTuiAgentLaunchArgs(agent, terminal).trim() === AUTO_TUI_AGENT_ARGS[agent]
  if (automatic('claude') && automatic('codex')) {
    return 'auto'
  }
  // Seed from each agent's arguments; the all-agent summary can reflect unrelated overrides.
  const bypasses = (agent: 'claude' | 'codex'): boolean =>
    resolvedTuiAgentArgsBypassPermissions(agent, terminal, platform)
  return bypasses('claude') && bypasses('codex') ? 'full-access' : 'ask'
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
