/** Adoption order by Session History row agent; registration tests require a transcript importer for every target.
 * Conversations stay on their recording host, which validates importer availability before adoption. */
export const CLI_CONVERSATION_ADOPTING_AGENTS = {
  claude: ['claude'],
  codex: ['codex'],
  grok: ['grok'],
  omp: ['omp'],
  opencode: ['opencode'],
  // OpenCode 2 chats require 2.x; ordinary OpenCode chats can adopt when their installed opencode is 2.x.
  opencode2: ['opencode2', 'opencode'],
  pi: ['pi']
} as const

/** A Session History row agent whose conversations a chat can take over. */
export type CliConversationRowAgent = keyof typeof CLI_CONVERSATION_ADOPTING_AGENTS

export function adoptsCliConversations(agent: unknown): agent is CliConversationRowAgent {
  return typeof agent === 'string' && Object.hasOwn(CLI_CONVERSATION_ADOPTING_AGENTS, agent)
}

/** Whether chats of the two agents can hold one conversation: both take over one row's. */
export function chatAgentsShareConversations(left: string, right: string): boolean {
  return (
    left === right ||
    Object.values(CLI_CONVERSATION_ADOPTING_AGENTS).some(
      (agents: readonly string[]) => agents.includes(left) && agents.includes(right)
    )
  )
}

/** Whether two rows' conversations can be one: a chat that takes over either takes over both. */
export function cliConversationRowsShareAgent(
  left: CliConversationRowAgent,
  right: CliConversationRowAgent
): boolean {
  const rightAgents: readonly string[] = CLI_CONVERSATION_ADOPTING_AGENTS[right]
  return CLI_CONVERSATION_ADOPTING_AGENTS[left].some((agent) => rightAgents.includes(agent))
}
