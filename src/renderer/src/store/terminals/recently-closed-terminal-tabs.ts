import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/workspace/ownership/resolve-owner'
import { buildAgentResumeStartupPlan } from '../../../../shared/agent-launch/startup/tui-agent-resume-startup'
import { tuiAgentToAgentKind } from '../../../../shared/agent-kind'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import {
  isWindowsAbsolutePathLike,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'
import {
  restoreRecentlyClosedTabPosition,
  type RecentlyClosedTabPosition
} from '../slices/tabs/recently-closed-tab-position'
import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { isWslUncPath } from '../../../../shared/wsl-paths'

/** Snapshot of a terminal tab captured at user-initiated close time.
 *  Reopen recreates a fresh tab (never the old PTY/scrollback). Plain shells
 *  restore Ghostty-style cwd/shell; resumable agent tabs relaunch via resume
 *  argv (#10377). */
export type ClosedTerminalTabSnapshot = {
  startupCwd?: string
  shellOverride?: string
  customTitle?: string
  color?: string
  position?: RecentlyClosedTabPosition
  agent?: ResumableTuiAgent
  providerSession?: AgentProviderSessionMetadata
  launchConfig?: SleepingAgentLaunchConfig
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

    const resumed = tryReopenClosedTerminalWithAgentResume(get, worktreeId, snapshot)
    if (resumed) {
      return true
    }

    const tab = get().createTab(worktreeId, snapshot.position?.groupId, snapshot.shellOverride, {
      ...(snapshot.startupCwd ? { startupCwd: snapshot.startupCwd } : {}),
      activate: true
    })
    applyClosedTerminalTabPresentation(get, tab.id, snapshot)
    get().setActiveTabType('terminal', worktreeId)
    restoreRecentlyClosedTabPosition(get, worktreeId, tab.id, snapshot.position)
    return true
  }
})

type StoreGet = () => AppState

function applyClosedTerminalTabPresentation(
  get: StoreGet,
  tabId: string,
  snapshot: ClosedTerminalTabSnapshot
): void {
  if (snapshot.customTitle) {
    get().setTabCustomTitle(tabId, snapshot.customTitle)
  }
  if (snapshot.color) {
    get().setTabColor(tabId, snapshot.color)
  }
}

function appendTabToBarOrder(get: StoreGet, worktreeId: string, tabId: string): void {
  const order = get().tabBarOrderByWorktree[worktreeId]
  if (order && !order.includes(tabId)) {
    get().setTabBarOrder(worktreeId, [...order, tabId])
  }
}

function getClientPlatform(): NodeJS.Platform {
  // Why: avoid importing new-workspace here — it pulls the full store and
  // creates a circular init cycle with this slice.
  if (typeof navigator !== 'undefined') {
    if (navigator.userAgent.includes('Windows')) {
      return 'win32'
    }
    if (navigator.userAgent.includes('Linux')) {
      return 'linux'
    }
  }
  return 'darwin'
}

// Why: SSH hosts need both Linux platform and isRemote so the planner uses the
// remote `orca` shim; WSL is Linux platform but still a local path (not isRemote).
function getResumeLaunchTarget(
  get: StoreGet,
  worktreeId: string
): { platform: NodeJS.Platform; isRemote: boolean } {
  const state = get()
  const worktree = state.getKnownWorktreeById?.(worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  if (repo?.connectionId) {
    return { platform: 'linux', isRemote: true }
  }
  if (worktree?.path && isWslUncPath(worktree.path)) {
    return { platform: 'linux', isRemote: false }
  }
  return { platform: getClientPlatform(), isRemote: false }
}

/** Resume a closed agent tab when the snapshot carries a resumable provider session. */
function tryReopenClosedTerminalWithAgentResume(
  get: StoreGet,
  worktreeId: string,
  snapshot: ClosedTerminalTabSnapshot
): boolean {
  if (!snapshot.agent || !snapshot.providerSession) {
    return false
  }
  const state = get()
  const launchConfig = snapshot.launchConfig
  const { platform, isRemote } = getResumeLaunchTarget(get, worktreeId)
  const startupPlan = buildAgentResumeStartupPlan({
    agent: snapshot.agent,
    providerSession: snapshot.providerSession,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    agentArgs:
      launchConfig !== undefined
        ? launchConfig.agentArgs
        : resolveTuiAgentLaunchArgs(snapshot.agent, state.settings),
    agentEnv:
      launchConfig !== undefined
        ? launchConfig.agentEnv
        : resolveTuiAgentLaunchEnv(snapshot.agent, state.settings),
    ...(launchConfig?.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    // Why: OMP cold resume stores a file path in the sleeping launch config; drop it
    // and the planner builds resume argv without the locator.
    ...(launchConfig?.ompResumeFilePath
      ? { ompResumeFilePath: launchConfig.ompResumeFilePath }
      : {}),
    platform,
    isRemote
  })
  if (!startupPlan) {
    return false
  }

  const tab = state.createTab(worktreeId, snapshot.position?.groupId, snapshot.shellOverride, {
    launchAgent: snapshot.agent,
    ...(snapshot.startupCwd ? { startupCwd: snapshot.startupCwd } : {}),
    activate: true
  })
  state.queueTabStartupCommand(tab.id, {
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    resumeProviderSession: snapshot.providerSession,
    launchAgent: snapshot.agent,
    ...(launchConfig ? { agentArgsOverride: launchConfig.agentArgs } : {}),
    ...(startupPlan.startupCommandDelivery
      ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
      : {}),
    showSessionRestoredBanner: true,
    telemetry: {
      agent_kind: tuiAgentToAgentKind(snapshot.agent),
      // Why: Cmd/Ctrl+Shift+T reopen is a keyboard shortcut path, not a sidebar launch.
      launch_source: 'shortcut',
      request_kind: 'resume'
    }
  })
  state.claimAutomaticAgentResume(tab.id, {
    worktreeId,
    launchAgent: snapshot.agent,
    providerSession: snapshot.providerSession
  })
  applyClosedTerminalTabPresentation(get, tab.id, snapshot)
  get().setActiveTabType('terminal', worktreeId)
  // Why: prefer main's closed-tab position restore when captured; fall back to
  // append so agent resume still works on older snapshots without position.
  if (snapshot.position) {
    restoreRecentlyClosedTabPosition(get, worktreeId, tab.id, snapshot.position)
  } else {
    appendTabToBarOrder(get, worktreeId, tab.id)
  }
  return true
}
