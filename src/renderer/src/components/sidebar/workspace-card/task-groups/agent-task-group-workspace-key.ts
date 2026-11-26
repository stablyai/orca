import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

/** Unstamped workspaces default to local, matching the card's agent-list disclosure key. */
export function agentTaskGroupWorkspaceKey(
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): string {
  return composeWorktreeHostIdentity(executionHostId ?? 'local', worktreeId)
}

/** Browsing for a folder opens this computer's picker, so only local workspaces offer it. */
export function canBrowseTaskGroupFolder(executionHostId: ExecutionHostId | undefined): boolean {
  return !executionHostId || executionHostId === 'local'
}

/** Attribute naming the conversation (terminal tab) a sidebar agent row belongs to. */
export const AGENT_ROW_TAB_ID_ATTR = 'data-agent-tab-id'

export function agentRowTabIdFromEvent(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null
  }
  return target.closest(`[${AGENT_ROW_TAB_ID_ATTR}]`)?.getAttribute(AGENT_ROW_TAB_ID_ATTR) ?? null
}
