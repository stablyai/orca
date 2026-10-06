// Stored account-home shape; the registered agent checks its variable when launching.
import { isAgentProfileSnapshot, type AgentProfileSnapshot } from './agent-launch-profile'
import type { AgentSessionStoredAgent } from './agent-session-stored-agent'

/** Account root pinned at launch, so a resume cannot drift to another login. */
export type AgentSessionAccountHome = {
  agentProfile?: AgentProfileSnapshot
  claudeAccountId?: string
  variable: string
  /** Host-resolved absolute path in the execution host's own path syntax. */
  path: string
}

const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const MAX_ID_LENGTH = 512
const MAX_PATH_LENGTH = 4096
function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

export function isAgentSessionAccountHome(value: unknown): value is AgentSessionAccountHome {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every admitted field is checked below before the object is exposed as an account home.
  const home = value as Partial<AgentSessionAccountHome>
  return (
    typeof home.variable === 'string' &&
    ENVIRONMENT_VARIABLE_NAME.test(home.variable) &&
    (home.claudeAccountId === undefined ||
      (home.variable === 'CLAUDE_CONFIG_DIR' &&
        isBoundedString(home.claudeAccountId, MAX_ID_LENGTH))) &&
    (home.agentProfile === undefined ||
      (isAgentProfileSnapshot(home.agentProfile) &&
        home.agentProfile.identity.kind === 'verified' &&
        home.agentProfile.resolvedHome === home.path &&
        home.variable ===
          (home.agentProfile.agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME') &&
        home.claudeAccountId === undefined)) &&
    isBoundedString(home.path, MAX_PATH_LENGTH)
  )
}

/** The account home declared by the registered agent. */
export function agentSessionAccountHome(
  agent: Pick<AgentSessionStoredAgent, 'accountHomeVariable'>,
  path: string
): AgentSessionAccountHome {
  return { variable: agent.accountHomeVariable, path }
}
