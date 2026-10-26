import type { ExecutionHostId } from '../../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import { resolveWorkspaceDirectory, type WorkspaceDirectoryState } from '@/lib/workspace-directory'
import type { StructuredSessionLaunchDirectory } from '@/store/slices/structured-session-launch-directories'
import { isStructuredTab } from '../../../../shared/structured-agent-session-tab'

type NativeChatDirectoryTab = {
  id: string
  entityId?: string
  contentType?: string
  agentSessionAgent?: unknown
}

export type NativeChatTabDirectoryState = WorkspaceDirectoryState & {
  unifiedTabsByWorktree?: Record<string, readonly NativeChatDirectoryTab[]>
  structuredSessionLaunchDirectoryByTabId?: Record<string, StructuredSessionLaunchDirectory>
}

export type NativeChatTabDirectoryResolution =
  | { status: 'resolved'; directory: string }
  /** A floating structured chat whose pinned folder the status feed has not delivered yet. */
  | { status: 'awaiting-pin' }
  | { status: 'unavailable' }

/** Use the host-pinned directory for floating structured chats; settings can move after launch. Other tabs resolve by workspace id. */
export function resolveNativeChatTabDirectoryResolution(
  state: NativeChatTabDirectoryState,
  tabId: string,
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
): NativeChatTabDirectoryResolution {
  const structuredTab = isFloatingWorkspaceId(worktreeId)
    ? // The status bridge's own predicate, so no tab waits on a pin it never mirrors.
      state.unifiedTabsByWorktree?.[worktreeId]?.find(
        (tab) => tab.id === tabId && isStructuredTab(tab)
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
  const pinned = state.structuredSessionLaunchDirectoryByTabId?.[tabId]
  // A missing pin may still be loading; settings cannot prove where this session runs.
  return pinned && pinned.sessionId === structuredTab.entityId
    ? { status: 'resolved', directory: pinned.launchDirectory }
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
