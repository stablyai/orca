import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { selectWorkspaceRuntimeEnvironmentId } from '@/lib/workspace/ownership/workspace-runtime-environment'
import { selectRemoteDesktopTabId } from './remote-desktop-tab'
import { reopenCloudRemoteDesktopQuietly } from './open-cloud-remote-desktop'

// Sleep closes a workspace's browser tabs (workspace-sleep-follower.ts), and the desktop's processes
// stop with the sandbox anyway. A remote desktop tab is remembered here and comes back on its own
// once the workspace is awake, in front again if it was in front.
const sleptWithDesktop = new Map<string, { wasInFront: boolean }>()

/** Call before sleep tears down the workspace's browser tabs. */
export function noteRemoteDesktopBeforeSleep(worktreeId: string): void {
  const state = useAppStore.getState()
  const tabId = selectRemoteDesktopTabId(state, worktreeId)
  if (!tabId) {
    return
  }
  sleptWithDesktop.set(worktreeId, {
    wasInFront:
      state.activeWorktreeId === worktreeId &&
      state.activeTabType === 'browser' &&
      state.activeBrowserTabId === tabId
  })
}

/** Reopens it when the workspace is running again (mounted for the workspace on screen). */
export function useReopenRemoteDesktopAfterWake(worktreeId: string, running: boolean): void {
  useEffect(() => {
    const entry = running ? sleptWithDesktop.get(worktreeId) : undefined
    if (!entry) {
      return
    }
    sleptWithDesktop.delete(worktreeId)
    const environmentId = selectWorkspaceRuntimeEnvironmentId(useAppStore.getState(), worktreeId)
    if (environmentId) {
      void reopenCloudRemoteDesktopQuietly(worktreeId, environmentId, entry.wasInFront)
    }
  }, [running, worktreeId])
}

export function hasRemoteDesktopToReopen(worktreeId: string): boolean {
  return sleptWithDesktop.has(worktreeId)
}

export function resetRemoteDesktopSleepReopenForTest(): void {
  sleptWithDesktop.clear()
}
