import type { GlobalSettings } from './global-settings-types'
import {
  resolvedTuiAgentArgsBypassPermissions,
  resolveTuiAgentLaunchArgs
} from './tui-agent-launch-defaults'
import { AUTO_TUI_AGENT_ARGS, YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
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

/** The lucide glyph each mode shows; desktop and phone resolve the name in their own icon package. */
export const AGENT_CHAT_PERMISSION_MODE_ICON_NAMES = {
  ask: 'Hand',
  'accept-edits': 'FilePenLine',
  auto: 'ShieldCheck',
  'full-access': 'ShieldAlert'
} as const satisfies Record<AgentChatPermissionMode, string>

export type AgentChatPermissionModeIconName =
  (typeof AGENT_CHAT_PERMISSION_MODE_ICON_NAMES)[AgentChatPermissionMode]

/** The chat option a mode is saved and written under. */
export const AGENT_CHAT_PERMISSION_MODE_OPTION_ID = 'permissionMode'

export function isAgentChatPermissionMode(value: unknown): value is AgentChatPermissionMode {
  return AGENT_CHAT_PERMISSION_MODES.some((mode) => mode === value)
}

/** The modes one agent's chats offer. */
export type AgentChatPermissionModeSupport = {
  modes: readonly AgentChatPermissionMode[]
  /** `auto` runs only on a model the agent's listing says supports it. */
  autoNeedsModelSupport?: true
}

const CLAUDE_CHAT_PERMISSION_MODES: AgentChatPermissionModeSupport = {
  modes: AGENT_CHAT_PERMISSION_MODES,
  autoNeedsModelSupport: true
}

const CODEX_CHAT_PERMISSION_MODES: AgentChatPermissionModeSupport = {
  modes: ['ask', 'auto', 'full-access']
}

// ACP chats: Orca answers the agent's permission requests yes under Full access, else the person does.
const ACP_CHAT_PERMISSION_MODES: AgentChatPermissionModeSupport = {
  modes: ['ask', 'full-access']
}

// No Auto: the server has no reviewer that answers approvals for the person.
const ANTIGRAVITY_CHAT_PERMISSION_MODES: AgentChatPermissionModeSupport = {
  modes: ['ask', 'accept-edits', 'full-access']
}

const AGENT_CHAT_PERMISSION_MODES_BY_AGENT = new Map<string, AgentChatPermissionModeSupport>([
  ['claude', CLAUDE_CHAT_PERMISSION_MODES],
  ['codex', CODEX_CHAT_PERMISSION_MODES],
  ['grok', ACP_CHAT_PERMISSION_MODES],
  ['opencode', ACP_CHAT_PERMISSION_MODES],
  ['opencode2', ACP_CHAT_PERMISSION_MODES],
  ['omp', ACP_CHAT_PERMISSION_MODES],
  ['antigravity', ANTIGRAVITY_CHAT_PERMISSION_MODES]
])

/** The one table of which agents' chats offer which modes; null keeps following Agent Permissions. */
export function agentChatPermissionModes(agent: string): AgentChatPermissionModeSupport | null {
  return AGENT_CHAT_PERMISSION_MODES_BY_AGENT.get(agent) ?? null
}

/** The saved choice if this agent offers it; anything else asks, never grants more access. */
export function savedChatPermissionMode(
  support: AgentChatPermissionModeSupport,
  intent: unknown
): AgentChatPermissionMode {
  return support.modes.find((mode) => mode === intent) ?? 'ask'
}

/** The one rule for whether the chat's model runs `auto`: its listed row, or the listed CLI default
 *  when it names none. The host launches with it and the menu offers with it. */
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

/** Whether the mode a chat runs depends on its model's listed `auto` support. */
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

/** The host's new-chat default as an agent's chat starts with it; null for an agent with none. */
export function newChatPermissionMode(
  agent: string,
  setting: unknown
): AgentChatPermissionMode | null {
  const support = agentChatPermissionModes(agent)
  return support ? savedChatPermissionMode(support, setting) : null
}

/** A scoped agent choice takes precedence over the shared new-chat default. */
export function newChatPermissionModeForSettings(
  agent: string,
  settings:
    | Partial<Pick<GlobalSettings, 'nativeChatPermissionMode' | 'agentNativeChatPermissionModes'>>
    | null
    | undefined
): AgentChatPermissionMode | null {
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
    resolveTuiAgentLaunchArgs(agent, terminal.agentDefaultArgs).trim() ===
    AUTO_TUI_AGENT_ARGS[agent]
  if (automatic('claude') && automatic('codex')) {
    return 'auto'
  }
  // Seed from each agent's arguments; the all-agent summary can reflect unrelated overrides.
  const bypasses = (agent: 'claude' | 'codex'): boolean =>
    resolvedTuiAgentArgsBypassPermissions(agent, terminal, platform)
  return bypasses('claude') && bypasses('codex') ? 'full-access' : 'ask'
}

/** Whether a chat saved before its agent had modes is filled as Full access: what its agent's own
 *  Arguments ran it with. An agent with no bypass argument never had that choice, so its chats take
 *  the new-chat setting. */
export function preModeChatGetsFullAccess(
  agent: TuiAgent,
  settings: Partial<
    Pick<GlobalSettings, 'agentDefaultArgs' | 'terminalWindowsShell' | 'nativeChatPermissionMode'>
  >,
  platform: NodeJS.Platform
): boolean {
  return agent in YOLO_TUI_AGENT_ARGS
    ? resolvedTuiAgentArgsBypassPermissions(agent, settings, platform)
    : settings.nativeChatPermissionMode === 'full-access'
}
