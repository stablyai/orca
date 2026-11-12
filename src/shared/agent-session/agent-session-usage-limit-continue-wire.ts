/** A usage-limited chat's automatic continue, as the host publishes it on the status summary. */
export type AgentSessionUsageLimitContinue = {
  turnItemId: string
  resetsAt: number
  /** The later reset the account still shows spent, which Orca waits for; absent: `resetsAt`. */
  continueAt?: number
  state: 'scheduled' | 'cancelled' | 'failed' | 'off'
}
