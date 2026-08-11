import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { AppState } from '../types'

type RemoteBrowserPageHandle = {
  environmentId: string
  remotePageId: string
}

export function closeRemoteBrowserPageInOwningEnvironment(
  worktreeId: string,
  handle: RemoteBrowserPageHandle
): void {
  void callRuntimeRpc(
    { kind: 'environment', environmentId: handle.environmentId },
    'browser.tabClose',
    { worktree: toRuntimeWorktreeSelector(worktreeId), page: handle.remotePageId },
    { timeoutMs: 15_000 }
  ).catch(() => {})
}

export function closeRemoteBrowserPagesForWorkspaces(
  state: Pick<AppState, 'browserPagesByWorkspace' | 'remoteBrowserPageHandlesByPageId'>,
  workspaceIds: readonly string[]
): void {
  for (const workspaceId of workspaceIds) {
    for (const page of state.browserPagesByWorkspace[workspaceId] ?? []) {
      const handle = state.remoteBrowserPageHandlesByPageId[page.id]
      if (handle) {
        closeRemoteBrowserPageInOwningEnvironment(page.worktreeId, handle)
      }
    }
  }
}
