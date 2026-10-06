/**
 * The account an agent session is pinned to: the agent's config directory, and the environment
 * variable that points the agent at it.
 *
 * The variable is the agent's own (Claude reads `CLAUDE_CONFIG_DIR`, Codex `CODEX_HOME`), declared
 * by its definition, so a record stores it beside the path. Stored values are exactly what older
 * builds wrote and read.
 */

import type { AgentSessionStoredAgent } from './agent-session-stored-agent'

/** Account root pinned at launch by the account selector, so a resume cannot drift to another login. */
export type AgentSessionAccountHome = {
  /** Environment variable naming the agent's config directory. */
  variable: string
  /** Host-resolved absolute path in the execution host's own path syntax. */
  path: string
}

/** The account home of `agent` at `path`. */
export function agentSessionAccountHome(
  agent: Pick<AgentSessionStoredAgent, 'accountHomeVariable'>,
  path: string
): AgentSessionAccountHome {
  return { variable: agent.accountHomeVariable, path }
}
