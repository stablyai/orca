import type { AgentHookTarget } from './agent-hook-types'

/** `agents` starts with the agent asked about, then every other undecided agent; callers keep the detected ones. */
export type AgentHookConsentOffer = {
  ask: boolean
  agents: AgentHookTarget[]
  /** The file the asked-about agent's hooks go in, home shortened to `~`; empty when unknown. */
  configPath: string
}
