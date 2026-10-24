/**
 * The chats that can take over a conversation their own CLI recorded, by the agent its Session
 * History row lists under, in the order a resume tries them: each one the host registers a
 * transcript import for, which a registration test checks. Only a conversation recorded on this
 * machine is offered, and this machine's host is this build, so the map cannot disagree with the
 * host that adopts.
 */
export const CLI_CONVERSATION_ADOPTING_AGENTS = {
  claude: ['claude'],
  codex: ['codex'],
  grok: ['grok'],
  omp: ['omp'],
  opencode: ['opencode'],
  // An OpenCode 2.x conversation: the OpenCode 2 chat runs only 2.x, an OpenCode chat runs 2.x
  // where `opencode` is 2.x.
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
