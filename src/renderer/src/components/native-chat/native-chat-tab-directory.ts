import type { ExecutionHostId } from '../../../../shared/execution-host'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import { resolveWorkspaceDirectory, type WorkspaceDirectoryState } from '@/lib/workspace-directory'
import type { StructuredSessionWorkspacePath } from '@/store/slices/structured-session-workspace-paths'

type NativeChatDirectoryTab = {
  id: string
  entityId?: string
  contentType?: string
  agentSessionAgent?: unknown
}

export type NativeChatTabDirectoryState = WorkspaceDirectoryState & {
  unifiedTabsByWorktree?: Record<string, readonly NativeChatDirectoryTab[]>
  structuredSessionWorkspacePathByTabId?: Record<string, StructuredSessionWorkspacePath>
}

export type NativeChatTabDirectoryResolution =
  | { status: 'resolved'; directory: string }
  /** A floating structured chat whose pinned folder the status feed has not delivered yet. */
  | { status: 'awaiting-pin' }
  | { status: 'unavailable' }

/**
 * The directory a native chat tab's agent runs in. A floating structured chat is held to the folder
 * its session was pinned to, because the floating setting can move after launch, so it has no
 * directory until the host publishes that pin. Every other tab resolves by workspace id exactly as
 * the host does.
 */
export function resolveNativeChatTabDirectoryResolution(
  state: NativeChatTabDirectoryState,
  tabId: string,
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
): NativeChatTabDirectoryResolution {
  const structuredTab = isFloatingWorkspaceId(worktreeId)
    ? // Same predicate as the status bridge that mirrors pins, so no tab waits on one never sent.
      state.unifiedTabsByWorktree?.[worktreeId]?.find(
        (tab) =>
          tab.id === tabId &&
          tab.contentType === 'agent-session' &&
          isAgentSessionHandleProvider(tab.agentSessionAgent)
      )
    : undefined
  if (!structuredTab) {
    const directory = resolveWorkspaceDirectory(state, worktreeId, executionHostId)
    return directory ? { status: 'resolved', directory } : { status: 'unavailable' }
  }
  // Why: a floating chat only runs on the local host, so no other host holds its folder.
  if (executionHostId && executionHostId !== 'local') {
    return { status: 'unavailable' }
  }
  const pinned = state.structuredSessionWorkspacePathByTabId?.[tabId]
  // Why no setting fallback: absence cannot tell "not delivered yet" from "none", and the setting
  // may name a folder this session never ran in.
  return pinned && pinned.sessionId === structuredTab.entityId
    ? { status: 'resolved', directory: pinned.workspacePath }
    : { status: 'awaiting-pin' }
}

export function resolveNativeChatTabDirectory(
  state: NativeChatTabDirectoryState,
  tabId: string,
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
): string | null {
  const resolution = resolveNativeChatTabDirectoryResolution(
    state,
    tabId,
    worktreeId,
    executionHostId
  )
  return resolution.status === 'resolved' ? resolution.directory : null
}
