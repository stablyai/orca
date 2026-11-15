import type { AgentStatusCacheIdentity } from '../../agent-status/contracts/agent-status-ipc-payload'
import type { SleepingAgentSessionRecord } from './agent-session-resume'

/** Runtime-only source shared by copies of one saved startup. Never persisted or sent to a host. */
export type SavedResumeStartupSource = {
  cancelled: boolean
  record?: SleepingAgentSessionRecord
  expectedStatus?: AgentStatusCacheIdentity
}
