// END-PASS CHAT-RENEW: which Orca Cloud environment a structured chat runs on, for every chat-side
// cloud check. A host-mirrored chat tab carries `runtime:<environment>`; a chat tab the desktop made
// itself may not, so its workspace's runtime owner names the environment (the sidebar row's own rule).
import type { AppState } from '@/store/types'
import { orcaCloudEnvironmentIdForWorktree } from '@/components/orca-cloud/use-cloud-agent-row-sign-in'
import { parseExecutionHostId } from '../../../../shared/execution-host'

/** The environment the chat's tab runs on (`runtime:` host, else its workspace's owner), or null. */
export function chatCloudEnvironmentId(
  state: Pick<AppState, 'unifiedTabsByWorktree'> &
    Parameters<typeof orcaCloudEnvironmentIdForWorktree>[0],
  tabId: string
): string | null {
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree ?? {})) {
    const tab = tabs?.find((candidate) => candidate.id === tabId)
    if (tab) {
      const host = parseExecutionHostId(tab.executionHostId)
      return host?.kind === 'runtime'
        ? host.environmentId
        : orcaCloudEnvironmentIdForWorktree(state, worktreeId)
    }
  }
  return null
}
