import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'

/** On teardown, close the daemon-side tab once its local page or runtime environment is gone. */
export function useCloseOrphanedRemotePageOnTeardown({
  activeRuntimeEnvironmentId,
  browserTabId,
  workspaceId,
  lifecycle,
  runtimeWorktree,
  worktreeId
}: {
  activeRuntimeEnvironmentId: string
  browserTabId: string
  workspaceId: string
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeWorktree: string
  worktreeId: string
}): void {
  useEffect(() => {
    if (!activeRuntimeEnvironmentId) {
      return
    }
    return () => {
      const remotePageId = lifecycle.tokens.remotePage
      if (!remotePageId) {
        return
      }
      const state = useAppStore.getState()
      const currentEnvironmentId = runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
      const pageStillExists =
        useAppStore
          .getState()
          .browserPagesByWorkspace[workspaceId]?.some((page) => page.id === browserTabId) ?? false
      if (currentEnvironmentId === activeRuntimeEnvironmentId && pageStillExists) {
        return
      }
      const removedHandle = state.removeRemoteBrowserPageHandle(browserTabId, remotePageId)
      lifecycle.tokens.setRemotePage(null)
      if (!removedHandle) {
        return
      }
      // Why: remote tabs outlive React components on the daemon; close only when the local page or its runtime environment is gone.
      void callRuntimeRpc(
        { kind: 'environment', environmentId: removedHandle.environmentId },
        'browser.tabClose',
        { worktree: runtimeWorktree, page: removedHandle.remotePageId },
        { timeoutMs: 15_000, suppressFeatureInteraction: true }
      ).catch(() => {})
    }
  }, [
    activeRuntimeEnvironmentId,
    browserTabId,
    workspaceId,
    lifecycle,
    runtimeWorktree,
    worktreeId
  ])
}
