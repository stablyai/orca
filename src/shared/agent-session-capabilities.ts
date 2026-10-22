/**
 * What a structured agent can do, declared before any session runs.
 *
 * Each agent's definition declares one record, and readers branch on it instead of on the agent's
 * name. A running session may narrow a declared capability (a Codex thread with legacy history
 * cannot rewind) but never widens one. Plain data, so a host can send it to clients as it is.
 */
export type AgentSessionCapabilities = {
  /** Roll the conversation back to before a turn. */
  rewind: boolean
  /** Compact the conversation's context on request: offers the `/compact` command. */
  compact: boolean
  /** A goal the user can set and change on the thread. */
  threadGoal: boolean
  /** Turns report how much of the context window they used. */
  contextUsage: boolean
  /** Prompts may carry images. */
  imagePrompts: boolean
  /** A message sent while a turn runs: handed to the running agent at once (`inject`), or held by
   *  Orca and sent as the next prompt once the turn ends (`queue`). */
  steering: 'inject' | 'queue'
  /**
   * Who applies the user's permission setting. `provider`: the agent is launched with it and
   * confines its own work. `orca`: Orca answers every permission request the agent sends by the
   * session's setting (a protocol-driven agent's value). The agent's own settings still decide
   * WHEN it asks, so only what it asks about is covered, never a sandbox.
   */
  approvalEnforcement: 'provider' | 'orca'
}
