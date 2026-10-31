import type { AgentChatPermissionMode } from './agent-chat-permission-mode'
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
  ['gemini', ACP_CHAT_PERMISSION_MODES],
  ['antigravity', ANTIGRAVITY_CHAT_PERMISSION_MODES]
])

/** The one table of which agents' chats offer which modes; null keeps following Agent Permissions. */
export function agentChatPermissionModes(agent: string): AgentChatPermissionModeSupport | null {
  return AGENT_CHAT_PERMISSION_MODES_BY_AGENT.get(agent) ?? null
}
