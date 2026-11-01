/** Branch on declared capabilities, not agent names. Sessions may narrow them (legacy Codex history cannot rewind), never widen them; plain data crosses the wire unchanged. */
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
  /** provider enforces its launch permission setting; orca answers emitted requests by the session setting. Provider settings still control when requests are emitted, so this is not sandboxing. */
  approvalEnforcement: 'provider' | 'orca'
}
