/**
 * The agents whose chats can take over a conversation their own CLI recorded, by the agent its
 * Session History row lists under: those the host registers a transcript import for, whose row
 * agents a registration test keeps equal to this map. Only a conversation recorded on this machine
 * is offered, and this machine's host is this build, so the map cannot disagree with the host
 * that adopts.
 */
export const CLI_CONVERSATION_ADOPTING_AGENTS = {
  claude: 'claude',
  codex: 'codex',
  grok: 'grok',
  omp: 'omp',
  opencode: 'opencode',
  // OpenCode 2.x lists its conversations as `opencode2` rows; an OpenCode chat runs either line.
  opencode2: 'opencode',
  pi: 'pi'
} as const

/** A Session History row agent whose conversations a chat can take over. */
export type CliConversationRowAgent = keyof typeof CLI_CONVERSATION_ADOPTING_AGENTS

/** The chat agent that takes a row agent's conversations over. */
export type CliConversationAdoptingAgent =
  (typeof CLI_CONVERSATION_ADOPTING_AGENTS)[CliConversationRowAgent]

export function adoptsCliConversations(agent: unknown): agent is CliConversationRowAgent {
  return typeof agent === 'string' && Object.hasOwn(CLI_CONVERSATION_ADOPTING_AGENTS, agent)
}
