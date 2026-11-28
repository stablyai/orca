import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/workspace/ownership/resolve-owner'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { buildSavedAgentResumeTabOptions } from '@/lib/agent-session/resume/saved-agent-resume-tab-options'
import { agentResumeOriginNamesAnotherExecutionHost } from '@/lib/agent-session/resume/sleeping-record-execution-host-scope'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import {
  isWindowsAbsolutePathLike,
  relativePathInsideRoot
} from '../../../../../shared/file-access/cross-platform-path'
import {
  getRecentlyClosedTabPosition,
  restoreRecentlyClosedTabPosition,
  type RecentlyClosedTabPosition
} from '../../slices/tabs/recently-closed-tab-position'

/** Reopen in a fresh PTY, resuming the provider session when one was captured. */
export type ClosedTerminalTabSnapshot = {
  startupCwd?: string
  shellOverride?: string
  customTitle?: string
  color?: string
  position?: RecentlyClosedTabPosition
  agentSession?: Pick<
    SleepingAgentSessionRecord,
    'agent' | 'providerSession' | 'launchConfig' | 'connectionId'
  >
}

const MAX_RECENT_CLOSED_TERMINAL_TABS = 10

export function captureClosedTerminalTabSnapshot(
  state: AppState,
  worktreeId: string,
  tab: TerminalTab,
  session: SleepingAgentSessionRecord | undefined
): ClosedTerminalTabSnapshot {
  return {
    startupCwd: tab.startupCwd,
    shellOverride: tab.shellOverride,
    customTitle: tab.customTitle ?? undefined,
    color: tab.color ?? undefined,
    position: getRecentlyClosedTabPosition(state, worktreeId, tab.id),
    ...(session
      ? {
          agentSession: {
            agent: session.agent,
            providerSession: session.providerSession,
            launchConfig: session.launchConfig,
            connectionId: session.connectionId
          }
        }
      : {})
  }
}

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
}

export const createRecentlyClosedTerminalTabsSlice: StateCreator<
  AppState,
  [],
  [],
  RecentlyClosedTerminalTabsSlice
> = (set, get) => ({
  recentlyClosedTerminalTabsByWorktree: {},

  reopenClosedTerminalTab: (worktreeId) => {
    // Skip local reopen for runtime-owned terminals: phantom shells race host snapshots; dispatcher falls through to browser/editor. Direct import avoids store cycle. Local/SSH are supported; remote terminal reopen remains deferred.
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

    const state = get()
    const agentSession = snapshot.agentSession
    const resume =
      agentSession &&
      !agentResumeOriginNamesAnotherExecutionHost(
        agentSession.connectionId,
        getExecutionHostIdForWorktree(state, worktreeId)
      )
        ? buildSavedAgentResumeTabOptions(state, worktreeId, agentSession, {
            launchSource: 'shortcut',
            startupCwd: snapshot.startupCwd,
            shellOverride: snapshot.shellOverride
          })
        : null
    const tab = state.createTab(worktreeId, snapshot.position?.groupId, snapshot.shellOverride, {
      ...resume,
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
})
