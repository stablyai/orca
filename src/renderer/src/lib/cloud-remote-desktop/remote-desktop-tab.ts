import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  selectWorkspaceRuntimeEnvironmentId,
  useWorkspaceRuntimeEnvironmentId
} from '@/lib/workspace/ownership/workspace-runtime-environment'
import { isCloudRemoteDesktopUrl } from '../../../../shared/hosted-sandbox/cloud-remote-desktop'
import { refreshCloudEnvironmentIds, useIsCloudEnvironment } from './cloud-environment-ids'
import { openCloudRemoteDesktop } from './open-cloud-remote-desktop'

/** The workspace's remote desktop tab (there is at most one), or null. */
export function selectRemoteDesktopTabId(state: AppState, worktreeId: string): string | null {
  const tab = (state.browserTabsByWorktree[worktreeId] ?? []).find((candidate) =>
    isCloudRemoteDesktopUrl(candidate.url)
  )
  return tab?.id ?? null
}

/**
 * The + menu's "Open Remote Desktop": goes to the workspace's desktop tab when there is one (its
 * chrome reconnects it if needed), else starts the desktop and opens the tab.
 */
export function openOrGoToRemoteDesktop(worktreeId: string): void {
  const state = useAppStore.getState()
  const existing = selectRemoteDesktopTabId(state, worktreeId)
  if (existing) {
    state.setActiveBrowserTab(existing, worktreeId)
    return
  }
  const environmentId = selectWorkspaceRuntimeEnvironmentId(state, worktreeId)
  if (environmentId) {
    void openCloudRemoteDesktop(worktreeId, environmentId)
  }
}

export type RemoteDesktopTabEntry = {
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
  return { available: Boolean(environmentId) && isCloud && canOpen, isGoTo }
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
