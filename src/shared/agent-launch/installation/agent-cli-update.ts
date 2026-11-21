// The host answers agentCliUpdate.check and agentCliUpdate.run.
export const AGENT_CLI_UPDATE_RUNTIME_CAPABILITY = 'agent-cli-update.v1' as const

/** Every agent whose own CLI a native chat runs; Antigravity runs Orca's fixed-version copy. */
export const AGENT_CLI_UPDATE_AGENTS = [
  'claude',
  'codex',
  'grok',
  'opencode',
  'opencode2',
  'omp',
  'copilot',
  'kimi',
  'cursor',
  'hermes',
  'goose'
] as const
export type AgentCliUpdateAgent = (typeof AGENT_CLI_UPDATE_AGENTS)[number]

/** What a check without `agents` answers, so clients that predate the list never see an agent they can't name. */
export const LEGACY_AGENT_CLI_UPDATE_AGENTS: readonly AgentCliUpdateAgent[] = ['claude', 'codex']

export function isAgentCliUpdateAgent(agent: string): agent is AgentCliUpdateAgent {
  return AGENT_CLI_UPDATE_AGENTS.some((known) => known === agent)
}

/** A model on Orca's list that the installed CLI is too old to offer. */
export type AgentCliModelRequirement = {
  /** As the CLI lists it once supported. */
  id: string
  name: string
  minVersion: string
}

/** The user's own CLI on a host, with a newer release out; Orca's own copies never appear here. */
export type AgentCliUpdate = {
  agent: AgentCliUpdateAgent
  installedVersion: string
  latestVersion: string
  /** What Update runs, or, when `runnable` is false, what the user runs themselves. */
  command: string
  runnable: boolean
  /** Newest first, each brought by the latest release; absent from hosts that predate it. */
  models?: AgentCliModelRequirement[]
}

export type AgentCliUpdateRunResult =
  | { ok: true }
  /** `command` is set once Orca ran one; absent when nothing ran or the host predates it. */
  | { ok: false; output: string; command?: string }
