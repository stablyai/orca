import { AgentLeaseExpiryTimers } from './agent-lease-expiry-timers'
import type { HookListenerState } from '../listener-state'
import { CLAUDE_OWED_NOTIFICATION_LEASE_PROVIDER } from '../providers/claude/background-tasks/claude-owed-notification-expiry-timers'
import { DROID_BACKGROUND_CHILD_LEASE_PROVIDER } from '../providers/droid/droid-lease-expiry'

export class HookLeaseExpiryTimers extends AgentLeaseExpiryTimers {
  constructor(state: HookListenerState) {
    super(state, [CLAUDE_OWED_NOTIFICATION_LEASE_PROVIDER, DROID_BACKGROUND_CHILD_LEASE_PROVIDER])
  }
}
