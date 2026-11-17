import { useCloudWorkspaceActions } from '@/components/orca-cloud/use-cloud-workspace-actions'
import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import { useWorkspaceRuntimeEnvironmentId } from '@/lib/workspace/ownership/workspace-runtime-environment'
import { refreshCloudEnvironmentIds, useIsCloudEnvironment } from './cloud-environment-ids'
import { selectRemoteDesktopTabId } from './open-cloud-remote-desktop'

type RemoteDesktopTabEntry = {
  /** Orca Cloud workspaces only. */
  available: boolean
  /** The workspace already has its desktop tab: the entry goes to it. */
  isGoTo: boolean
}

export function useRemoteDesktopTabEntry(worktreeId: string): RemoteDesktopTabEntry {
  const environmentId = useWorkspaceRuntimeEnvironmentId(worktreeId)
  const isCloud = useIsCloudEnvironment(environmentId)
  const isGoTo = useAppStore((state) => selectRemoteDesktopTabId(state, worktreeId) !== null)
  useEffect(() => {
    if (environmentId) {
      void refreshCloudEnvironmentIds()
    }
  }, [environmentId])
  const canOpen =
    typeof window !== 'undefined' &&
    typeof window.api?.ephemeralVm?.openCloudRemoteDesktop === 'function'
  // LIFECYCLE-MATRIX: only where the workspace can run it (a live VM).
  const lifecycle = useCloudWorkspaceActions(worktreeId)
  const runnable = lifecycle === null || lifecycle.offers('remoteDesktop')
  return { available: Boolean(environmentId) && isCloud && canOpen && runnable, isGoTo }
}

/** The + menu entry's model, stable across renders: null where it is not offered. */
export function useRemoteDesktopMenuOption(
  worktreeId: string,
  terminalOnly: boolean
): { isGoTo: boolean } | null {
  const { available, isGoTo } = useRemoteDesktopTabEntry(worktreeId)
  const offered = available && !terminalOnly
  return useMemo(() => (offered ? { isGoTo } : null), [offered, isGoTo])
}
