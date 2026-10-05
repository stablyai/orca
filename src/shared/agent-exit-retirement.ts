/**
 * The origin of an agent-exit observation, captured when the exit was observed and carried
 * unchanged to the mutation that retires the pane's chat. A conditional fence, never send
 * authority: a later intent on the tab or a rebinding of the pane makes the retirement a no-op.
 */
export type AgentExitRetirementCondition = {
  leafId: string
  /** The PTY the exit was seen on; absent from a paired client, whose ids are not the host's. */
  ptyId?: string
  /** Same-machine origin: an intent on the tab at or after this instant supersedes the exit. */
  observedAtMs?: number
  /** Cross-host origin: the host's token for this pane when the exit was observed. */
  presentationToken?: string
}

/** What a pane's exit callback carries from the moment the exit was observed. */
export type AgentExitObservationOrigin = { ptyId: string | null; observedAtMs: number }

/** `unchanged`: nothing left to retire (already terminal, no hint). Only `applied` mutated. */
export type AgentExitRetirementDisposition = 'applied' | 'unchanged' | 'superseded' | 'missing'
