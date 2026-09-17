import type { LiveAgentSessionOwner } from './claimed-agent-pty-owner-snapshot'
import { countClaimedAgentPtyOwners } from './claimed-agent-pty-owner-snapshot'

export const MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES = 1024

export function assertClaimedAgentPtyOwnerCapacity(
  live: ReadonlyMap<string, LiveAgentSessionOwner>,
  conflicts: ReadonlyMap<string, readonly LiveAgentSessionOwner[]>,
  reservedCount: number
): void {
  if (
    countClaimedAgentPtyOwners(live, conflicts) + reservedCount >=
    MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES
  ) {
    throw new Error('execution_owner_unavailable')
  }
}
