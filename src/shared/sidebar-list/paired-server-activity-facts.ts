import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { getWorkspaceSessionTabActivity } from '../workspace-session-tab-activity'
import {
  composeWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../worktree/host-qualified-identity'
import { worktreeIdentityKey } from '../worktree/id'
import type { PairedServerRowsSnapshot } from './paired-server-rows'
import { isIdleWorkspaceActivity, type WorkspaceActivityFacts } from './workspace-activity-facts'

/**
 * A paired server's rows under their host-qualified keys, like the review facts: its terminals and
 * agents as the server reports them, and the browser and chat tabs this desktop's session holds
 * there, which only the desktop knows. Rows from a server out of contact keep their terminals
 * unverifiable, never gone (docs/reference/ssh-execution-boundary.md).
 */
export function buildPairedServerActivityFacts(
  servers: readonly Pick<
    PairedServerRowsSnapshot['servers'][number],
    'hostId' | 'freshness' | 'rows'
  >[],
  sessionOf: (
    hostId: ExecutionHostId
  ) => Pick<WorkspaceSessionState, 'browserTabsByWorktree' | 'unifiedTabs'> | null
): Record<HostScopedWorktreeKey, WorkspaceActivityFacts> {
  const facts: Record<HostScopedWorktreeKey, WorkspaceActivityFacts> = {}
  for (const server of servers) {
    const parsed = parseExecutionHostId(server.hostId)
    if (parsed?.kind !== 'runtime') {
      continue
    }
    const hostId = toRuntimeExecutionHostId(parsed.environmentId)
    const tabs = getWorkspaceSessionTabActivity(sessionOf(hostId))
    const browser = new Set([...tabs.browser].map(worktreeIdentityKey))
    const structuredChat = new Set([...tabs.structuredChat].map(worktreeIdentityKey))
    for (const row of server.rows) {
      const reported = row.activity
      const key = worktreeIdentityKey(row.worktreeId)
      const fact: WorkspaceActivityFacts = {
        terminal:
          reported?.terminal === 'live' && server.freshness !== 'live'
            ? 'unverifiable'
            : (reported?.terminal ?? null),
        browser: browser.has(key),
        structuredChat: structuredChat.has(key),
        agent: reported?.agent ?? null
      }
      if (!isIdleWorkspaceActivity(fact)) {
        facts[composeWorktreeHostIdentity(hostId, row.worktreeId)] = fact
      }
    }
  }
  return facts
}
