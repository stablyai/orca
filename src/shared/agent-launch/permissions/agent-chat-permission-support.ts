import type {
  AgentChatPermissionChoice,
  AgentChatPermissionMode
} from './agent-chat-permission-mode'
/** The modes one agent's chats offer. */
export type AgentChatPermissionModeSupport = {
  modes: readonly AgentChatPermissionMode[]
}

const CLAUDE_CHAT_PERMISSION_MODES: AgentChatPermissionModeSupport = {
  modes: ['ask', 'accept-edits', 'auto', 'full-access']
}

const CODEX_CHAT_PERMISSION_MODES: AgentChatPermissionModeSupport = {
  modes: ['ask', 'auto', 'full-access']
}

// ACP chats: Orca answers the agent's permission requests yes under Full access, else the person does.
const ACP_CHAT_PERMISSION_MODES: AgentChatPermissionModeSupport = {
  modes: ['ask', 'full-access']
}

// The agent's own Ask When Needed mode approves routine work and still asks before risky commands.
const ASK_WHEN_NEEDED_CHAT_PERMISSION_MODES: AgentChatPermissionModeSupport = {
  modes: ['ask', 'auto', 'full-access']
}

// No Auto: the agent has no reviewer that answers approvals for the person.
const EDIT_ACCEPTING_CHAT_PERMISSION_MODES: AgentChatPermissionModeSupport = {
  modes: ['ask', 'accept-edits', 'full-access']
}

/** Every agent that has a native chat. */
export const NATIVE_CHAT_AGENTS = [
  'claude',
  'codex',
  'grok',
  'opencode',
  'opencode2',
  'omp',
  'copilot',
  'cursor',
  'kimi',
  'bqagent',
  'kiro',
  'pi',
  'antigravity',
  'hermes',
  'goose',
  'aug',
  'kilo',
  'mimo-code',
  'gemini',
  'droid',
  'qwen-code'
] as const

export type NativeChatAgent = (typeof NATIVE_CHAT_AGENTS)[number]

const AGENT_CHAT_PERMISSION_MODES_BY_AGENT: Record<
  NativeChatAgent,
  AgentChatPermissionModeSupport | null
> = {
  claude: CLAUDE_CHAT_PERMISSION_MODES,
  codex: CODEX_CHAT_PERMISSION_MODES,
  grok: ACP_CHAT_PERMISSION_MODES,
  opencode: ACP_CHAT_PERMISSION_MODES,
  opencode2: ACP_CHAT_PERMISSION_MODES,
  omp: ACP_CHAT_PERMISSION_MODES,
  copilot: ACP_CHAT_PERMISSION_MODES,
  cursor: ACP_CHAT_PERMISSION_MODES,
  kimi: ASK_WHEN_NEEDED_CHAT_PERMISSION_MODES,
  kiro: ACP_CHAT_PERMISSION_MODES,
  goose: ASK_WHEN_NEEDED_CHAT_PERMISSION_MODES,
  droid: ASK_WHEN_NEEDED_CHAT_PERMISSION_MODES,
  // Pi asks no approvals, so its chats run with every tool it has, as its terminal does.
  pi: null,
  bqagent: null,
  antigravity: EDIT_ACCEPTING_CHAT_PERMISSION_MODES,
  hermes: EDIT_ACCEPTING_CHAT_PERMISSION_MODES,
  // Auggie asks none unless its own tool permissions say so, as in its terminal.
  aug: null,
  kilo: ACP_CHAT_PERMISSION_MODES,
  'mimo-code': ACP_CHAT_PERMISSION_MODES,
  gemini: ACP_CHAT_PERMISSION_MODES,
  // Qwen's own modes: Auto Edit approves edits, and Auto has a model approve what is safe.
  'qwen-code': CLAUDE_CHAT_PERMISSION_MODES
}

export function isNativeChatAgent(agent: string): agent is NativeChatAgent {
  return NATIVE_CHAT_AGENTS.some((entry) => entry === agent)
}

/** A native chat that asks no approvals, so it always runs with every tool its agent has. */
export function chatAsksNoApprovals(agent: string): boolean {
  return isNativeChatAgent(agent) && AGENT_CHAT_PERMISSION_MODES_BY_AGENT[agent] === null
}

/** The one table of which agents' chats offer which modes; null keeps following Agent Permissions. */
export function agentChatPermissionModes(agent: string): AgentChatPermissionModeSupport | null {
  return isNativeChatAgent(agent) ? AGENT_CHAT_PERMISSION_MODES_BY_AGENT[agent] : null
}

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
