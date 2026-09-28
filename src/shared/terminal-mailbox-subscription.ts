export const TERMINAL_MAILBOX_SUBSCRIPTION_CAPABILITY = 'orchestration.terminal-subscription.v1'

export type TerminalMailboxWake = 'submitted' | 'deferred' | 'unsupported' | 'unverifiable'

export type TerminalMailboxSubscriptionState =
  | 'active'
  | 'blocked_permission'
  | 'blocked_working'
  | 'ambiguous_write'
  | 'stale_replaced'
  | 'host_unverifiable'
  | 'proven_exited'
  | 'unsubscribed'

export type TerminalMailboxSubscriptionStatus = {
  subscribed: boolean
  state: TerminalMailboxSubscriptionState
  wake: TerminalMailboxWake
  reason: string
  messageIds: string[]
  createdAt: string | null
  submitPolicy: 'recognized_non_cursor'
}

export type TerminalMailboxSubscriptionResult = TerminalMailboxSubscriptionStatus & {
  historicalReplay?: unknown
  mutation?: { requestId: string; replayed: boolean }
}
