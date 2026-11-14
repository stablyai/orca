// Imported backup/set-aside records may hide an already granted fence: choose above the recovery floor to prevent a second equal-fence writer.
// Keep the current fence for proven live handles; moving it invalidates them. The source ratchet catches direct + 1 mints only; transition tests pin the bound/floor.

import type { AgentSessionLease } from './agent-session-record'

export function nextAgentSessionFence(lease: AgentSessionLease): number {
  return Math.max(lease.runtimeFence + 1, lease.minimumNextFence ?? 0)
}
