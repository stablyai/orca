/** A usage-limited chat's automatic continue, as the host publishes it on the status summary. */
export type AgentSessionUsageLimitContinue = {
  turnItemId: string
  resetsAt: number
  /** When Orca continues instead of `resetsAt`: later while the account still shows spent,
   *  earlier once the chat would continue on another account. Absent: `resetsAt`. */
  continueAt?: number
  /** The account the chat moved to, itself out of quota until `continueAt`; absent from older
   *  hosts and when the chat moved to an account with room; '' when that account has no name. */
  limitedAccount?: string
  state: 'scheduled' | 'cancelled' | 'failed' | 'off'
}
