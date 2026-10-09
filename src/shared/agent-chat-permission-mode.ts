/** A chat's own permission choice, independent of terminal launch settings. */
export type AgentChatPermissionMode = 'ask' | 'accept-edits' | 'auto' | 'bypass'

/** Picker order: least to most access. */
export const AGENT_CHAT_PERMISSION_MODES = [
  'ask',
  'accept-edits',
  'auto',
  'bypass'
] as const satisfies readonly AgentChatPermissionMode[]

/** The session option a chat's mode is written and persisted under. */
export const AGENT_CHAT_PERMISSION_MODE_OPTION_ID = 'permissionMode'

export function isAgentChatPermissionMode(value: unknown): value is AgentChatPermissionMode {
  return AGENT_CHAT_PERMISSION_MODES.some((mode) => mode === value)
}

/** Unknown reviewer support offers Auto; only a known refusal removes it. */
export type AgentChatPermissionModeSupport = { autoReview?: boolean }

/** Only Claude and Codex expose chat permissions; unsupported reviewer modes are withheld. */
export function agentChatPermissionModes(
  agent: string,
  support: AgentChatPermissionModeSupport = {}
): readonly AgentChatPermissionMode[] | null {
  const autoReview = support.autoReview !== false
  if (agent === 'claude') {
    return autoReview ? AGENT_CHAT_PERMISSION_MODES : ['ask', 'accept-edits', 'bypass']
  }
  if (agent === 'codex') {
    return autoReview ? ['ask', 'auto', 'bypass'] : ['ask', 'bypass']
  }
  return null
}

export function agentChatPermissionModeSupported(
  agent: string,
  value: unknown,
  support?: AgentChatPermissionModeSupport
): value is AgentChatPermissionMode {
  return (
    isAgentChatPermissionMode(value) &&
    Boolean(agentChatPermissionModes(agent, support)?.includes(value))
  )
}

/** Unknown settings from another build must never grant more access. */
export function agentChatPermissionModeFromSetting(setting: unknown): AgentChatPermissionMode {
  return isAgentChatPermissionMode(setting) ? setting : 'ask'
}

/** The chat's own stored choice, when its record holds a valid one for this agent. */
export function storedAgentChatPermissionMode(
  agent: string,
  options: Readonly<Record<string, string>> | null | undefined
): AgentChatPermissionMode | null {
  const stored = options?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID]
  return agentChatPermissionModeSupported(agent, stored) ? stored : null
}

/** A saved chat choice outranks the host default; unsupported values ask. */
export function agentChatLaunchPermissionMode(
  agent: string,
  options: Readonly<Record<string, string>> | null | undefined,
  setting: unknown,
  support: AgentChatPermissionModeSupport = {}
): AgentChatPermissionMode {
  const value = options?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] ?? setting
  return agentChatPermissionModeSupported(agent, value, support) ? value : 'ask'
}

/** What a host publishes about a chat's mode; absent from a host that predates the picker. */
export type AgentSessionPermissionModes = {
  /** Retained chat intent; capability confirmation may narrow it before a turn. */
  current: AgentChatPermissionMode
  supported: readonly AgentChatPermissionMode[]
  fence?: number
  revision?: number
}

/** The host's permission intent and fence when it publishes a chat tab. */
export type AgentSessionPermissionFact = {
  mode: AgentChatPermissionMode | null
  fence: number
  revision?: number
}
export type AgentSessionPermissionFrameFields = {
  permissionMode?: AgentChatPermissionMode | null
  permissionRevision?: number
}
export type AgentSessionPermissionSeed = AgentSessionPermissionFact & {
  mode: AgentChatPermissionMode
}

/** Unknown host modes hide the picker rather than granting guessed access. */
export function parseAgentSessionPermissionModes(
  value: unknown
): AgentSessionPermissionModes | null {
  if (!value || typeof value !== 'object' || !('current' in value) || !('supported' in value)) {
    return null
  }
  const { current, supported: listed } = value
  const supported = Array.isArray(listed) ? listed.filter(isAgentChatPermissionMode) : []
  return isAgentChatPermissionMode(current) && supported.length > 0 ? { current, supported } : null
}

/** A host launch seed proves picker support until a live report replaces it. */
export function commitAgentSessionPermissionMode(
  permission: AgentSessionPermissionModes | null,
  agent: string,
  value: string
): AgentSessionPermissionModes | null {
  if (!isAgentChatPermissionMode(value)) {
    return permission
  }
  if (permission) {
    return permission.supported.includes(value) ? { ...permission, current: value } : permission
  }
  if (!agentChatPermissionModeSupported(agent, value)) {
    return null
  }
  const supported = agentChatPermissionModes(agent)
  if (!supported) {
    return null
  }
  return { current: value, supported }
}
