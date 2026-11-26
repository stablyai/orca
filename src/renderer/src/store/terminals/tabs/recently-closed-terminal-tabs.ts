import { resolveWebSessionVisibleTabId } from '@/runtime/web-session-tabs-sync/navigation/web-session-focus-intent'
import {
  getRuntimeEnvironmentRevision,
  isRuntimeEnvironmentContinuationPending,
  resolveContinuedRuntimeEnvironmentRevision
} from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import {
  captureWebSessionIntentOwner,
  matchesWebSessionIntentOwner
} from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import type { WebSessionIntentOwner } from '@/runtime/web-session-tabs-sync/identity/web-session-intent-owner'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/workspace/ownership/resolve-owner'
import {
  isWindowsAbsolutePathLike,
  relativePathInsideRoot
} from '../../../../../shared/file-access/cross-platform-path'
import {
  restoreRecentlyClosedTabPosition,
  type RecentlyClosedTabPosition
} from '../../slices/tabs/recently-closed-tab-position'

/** Reopen user-closed terminals as fresh shells at original cwd, never old PTYs, scrollback or agent sessions (Ghostty semantics). */
export type ClosedTerminalTabSnapshot = {
  remote?: WebSessionIntentOwner & { mutationId: string }
  startupCwd?: string
  shellOverride?: string
  customTitle?: string
  color?: string
  position?: RecentlyClosedTabPosition
}

export function captureClosedTerminalTabSnapshot(
  tab: Pick<TerminalTab, 'startupCwd' | 'shellOverride' | 'customTitle' | 'color'>,
  position?: RecentlyClosedTabPosition,
  environmentId?: string
): ClosedTerminalTabSnapshot | null {
  const owner = environmentId ? captureWebSessionIntentOwner(environmentId) : null
  if (owner && owner.pairingRevision === undefined) {
    return null
  }
  return {
    ...(owner ? { remote: { ...owner, mutationId: createNonSecureContextUuid() } } : {}),
    ...(tab.startupCwd ? { startupCwd: tab.startupCwd } : {}),
    ...(tab.shellOverride ? { shellOverride: tab.shellOverride } : {}),
    ...(tab.customTitle ? { customTitle: tab.customTitle } : {}),
    ...(tab.color ? { color: tab.color } : {}),
    ...(position ? { position } : {})
  }
}

const MAX_RECENT_CLOSED_TERMINAL_TABS = 10

// Partial single-slice test stores can omit these maps.
export function pushClosedTerminalTabSnapshot(
  map: Record<string, ClosedTerminalTabSnapshot[]> | undefined,
  worktreeId: string,
  snapshot: ClosedTerminalTabSnapshot
): Record<string, ClosedTerminalTabSnapshot[]> {
  return {
    ...map,
    [worktreeId]: [snapshot, ...(map?.[worktreeId] ?? [])].slice(0, MAX_RECENT_CLOSED_TERMINAL_TABS)
  }
}

export function remapClosedTerminalTabSnapshotCwds(
  snapshots: ClosedTerminalTabSnapshot[],
  oldWorktreePath: string,
  newWorktreePath: string
): ClosedTerminalTabSnapshot[] {
  return snapshots.map((snapshot) => {
    if (!snapshot.startupCwd) {
      return snapshot
    }
    const relative = relativePathInsideRoot(oldWorktreePath, snapshot.startupCwd)
    if (relative === null) {
      return snapshot
    }
    if (!relative) {
      return { ...snapshot, startupCwd: newWorktreePath }
    }
    const useBackslash =
      isWindowsAbsolutePathLike(newWorktreePath) && newWorktreePath.includes('\\')
    const separator = useBackslash ? '\\' : '/'
    const base = newWorktreePath.replace(/[\\/]+$/g, '')
    const suffix = useBackslash ? relative.replace(/\//g, '\\') : relative
    return { ...snapshot, startupCwd: `${base}${separator}${suffix}` }
  })
}

export type RecentlyClosedTerminalTabsSlice = {
  /** Newest-first snapshots of user-closed terminal tabs, per worktree. */
  recentlyClosedTerminalTabsByWorktree: Record<string, ClosedTerminalTabSnapshot[]>
  reopenClosedTerminalTab: (worktreeId: string) => boolean
  reopenRemoteTerminalTab: (worktreeId: string, snapshot: ClosedTerminalTabSnapshot) => boolean
}

export const createRecentlyClosedTerminalTabsSlice: StateCreator<
  AppState,
  [],
  [],
  RecentlyClosedTerminalTabsSlice
> = (set, get) => {
  const pending = new Set<string>()
  return {
    recentlyClosedTerminalTabsByWorktree: {},

    reopenRemoteTerminalTab: (worktreeId, snapshot) => {
      const remote = snapshot.remote
      if (!remote || remote.pairingRevision === undefined || pending.has(remote.mutationId)) {
        return false
      }
      const forgetSnapshot = () =>
        set((state) => {
          const rows = state.recentlyClosedTerminalTabsByWorktree[worktreeId] ?? []
          if (!rows.some((row) => row.remote?.mutationId === remote.mutationId)) {
            return state
          }
          return {
            recentlyClosedTerminalTabsByWorktree: {
              ...state.recentlyClosedTerminalTabsByWorktree,
              [worktreeId]: rows.filter((row) => row.remote?.mutationId !== remote.mutationId)
            },
            recentlyClosedTabKindsByWorktree: {
              ...state.recentlyClosedTabKindsByWorktree,
              [worktreeId]: (state.recentlyClosedTabKindsByWorktree[worktreeId] ?? []).filter(
                (kind) => typeof kind !== 'object' || kind.remoteTerminalId !== remote.mutationId
              )
            }
          }
        })
      const pairingRevision =
        resolveContinuedRuntimeEnvironmentRevision(remote.environmentId, remote.pairingRevision) ??
        remote.pairingRevision
      const currentRevision = getRuntimeEnvironmentRevision(remote.environmentId)
      if (
        currentRevision !== undefined &&
        currentRevision !== pairingRevision &&
        !isRuntimeEnvironmentContinuationPending(remote.environmentId, remote.pairingRevision)
      ) {
        forgetSnapshot()
        return false
      }
      const sameHost = () => {
        const owner = runtimeEnvironmentIdForWorkspaceOwner(get(), { workspaceId: worktreeId })
        return (
          owner.kind === 'resolved' &&
          owner.environmentId === remote.environmentId &&
          matchesWebSessionIntentOwner({ environmentId: remote.environmentId, pairingRevision })
        )
      }
      if (!sameHost()) {
        return false
      }
      const activeTab = resolveWebSessionVisibleTabId(get(), worktreeId)
      pending.add(remote.mutationId)
      void import('@/runtime/hosted-terminals/creation/web-runtime-terminal-creation')
        .then(async ({ createWebRuntimeSessionTerminalOnHost }) => {
          if (!sameHost()) {
            return
          }
          const result = await createWebRuntimeSessionTerminalOnHost({
            worktreeId,
            environmentId: remote.environmentId,
            cwd: snapshot.startupCwd,
            shell: snapshot.shellOverride,
            targetGroupId: snapshot.position?.groupId,
            reopen: {
              mutationId: remote.mutationId,
              pairingRevision,
              customTitle: snapshot.customTitle,
              color: snapshot.color
            },
            selectWorktree: false,
            activate: false
          })
          if (result.status !== 'created' || !sameHost()) {
            return
          }
          forgetSnapshot()
          if (result.mirroredTabId) {
            restoreRecentlyClosedTabPosition(
              get,
              worktreeId,
              result.mirroredTabId,
              snapshot.position
            )
            if (
              get().activeWorktreeId === worktreeId &&
              resolveWebSessionVisibleTabId(get(), worktreeId) === activeTab
            ) {
              get().setActiveTab(result.mirroredTabId)
              get().setActiveTabType('terminal', worktreeId)
            }
          }
        })
        .catch((error) => console.warn('[reopen-terminal]', error))
        .finally(() => pending.delete(remote.mutationId))
      return true
    },
    reopenClosedTerminalTab: (worktreeId) => {
      const owner = runtimeEnvironmentIdForWorkspaceOwner(get(), { workspaceId: worktreeId })
      // Why: a twin's reopen would spawn a local shell for a tab that may have lived on the other host.
      if (owner.kind === 'ambiguous' || owner.environmentId?.trim()) {
        return false
      }
      // Atomically pop inside set or rapid reopen gestures restore the same snapshot twice.
      let snapshot: ClosedTerminalTabSnapshot | undefined
      set((s) => {
        const stack = s.recentlyClosedTerminalTabsByWorktree[worktreeId] ?? []
        snapshot = stack[0]
        if (!snapshot) {
          return s
        }
        return {
          recentlyClosedTerminalTabsByWorktree: {
            ...s.recentlyClosedTerminalTabsByWorktree,
            [worktreeId]: stack.slice(1)
          }
        }
      })
      if (!snapshot) {
        return false
      }

      const tab = get().createTab(worktreeId, snapshot.position?.groupId, snapshot.shellOverride, {
        ...(snapshot.startupCwd ? { startupCwd: snapshot.startupCwd } : {}),
        activate: true
      })
      if (snapshot.customTitle) {
        get().setTabCustomTitle(tab.id, snapshot.customTitle)
      }
      if (snapshot.color) {
        get().setTabColor(tab.id, snapshot.color)
      }
      get().setActiveTabType('terminal', worktreeId)
      restoreRecentlyClosedTabPosition(get, worktreeId, tab.id, snapshot.position)
      return true
    }
  }
}
