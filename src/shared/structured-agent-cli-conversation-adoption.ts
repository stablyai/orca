/** Adoption order by Session History row agent; registration tests require a transcript importer for every target.
 * Offer only local conversations, whose adopting host runs this build and therefore agrees with the map. */
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

/** The one enablement source for moving a conversation between chat and terminal in place: the
 *  agents whose chat catches up on turns made elsewhere and whose terminal start Orca can watch. */
export const IN_PLACE_SWITCH_AGENTS: readonly CliConversationRowAgent[] = ['codex']

export function inPlaceSwitchEnabled(agent: unknown): boolean {
  return adoptsCliConversations(agent) && IN_PLACE_SWITCH_AGENTS.includes(agent)
}

/** What a host advertises per enabled agent; a peer without it never receives a switch. */
export function inPlaceSwitchCapability(agent: string): string {
  return `agent-session.structured.switch.v1:${agent}`
}

export const IN_PLACE_SWITCH_RUNTIME_CAPABILITIES =
  IN_PLACE_SWITCH_AGENTS.map(inPlaceSwitchCapability)

/** `saved`: built from a pane's saved facts; `switch`: the terminal half of a chat's switch. */
export type TerminalResumeOrigin = 'saved' | 'switch'
