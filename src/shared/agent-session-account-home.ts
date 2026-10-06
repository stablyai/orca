/**
 * The account an agent session is pinned to: the agent's config directory, and the environment
 * variable that points the agent at it.
 *
 * The variable is the agent's own (Claude reads `CLAUDE_CONFIG_DIR`, Codex `CODEX_HOME`), so a
 * record stores it beside the path and a new agent names its own here. Stored values are exactly
 * what older builds wrote and read.
 */

import type { AgentSessionHandleProvider } from './agent-session-provider-handle'

/** Account root pinned at launch by the account selector, so a resume cannot drift to another login. */
export type AgentSessionAccountHome = {
  /** Environment variable naming the agent's config directory. */
  variable: string
  /** Host-resolved absolute path in the execution host's own path syntax. */
  path: string
}

const CONFIG_DIRECTORY_VARIABLES: Readonly<Record<AgentSessionHandleProvider, string>> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME'
}

const KNOWN_CONFIG_DIRECTORY_VARIABLES: ReadonlySet<string> = new Set(
  Object.values(CONFIG_DIRECTORY_VARIABLES)
)

/** The variable an account home of this agent pins. */
export function agentConfigDirectoryVariable(agent: AgentSessionHandleProvider): string {
  return CONFIG_DIRECTORY_VARIABLES[agent]
}

/** The account home of `agent` at `path`. */
export function agentSessionAccountHome(
  agent: AgentSessionHandleProvider,
  path: string
): AgentSessionAccountHome {
  return { variable: agentConfigDirectoryVariable(agent), path }
}

/** Admits only a variable some agent declares: a record's variable becomes a child's environment. */
export function isAgentConfigDirectoryVariable(value: unknown): value is string {
  return typeof value === 'string' && KNOWN_CONFIG_DIRECTORY_VARIABLES.has(value)
}
