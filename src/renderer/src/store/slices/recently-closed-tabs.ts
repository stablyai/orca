import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import {
  isWindowsAbsolutePathLike,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'
import {
  restoreRecentlyClosedTabPosition,
  type RecentlyClosedTabPosition
} from './recently-closed-tab-position'
import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import { isWslUncPath } from '../../../../shared/wsl-paths'

export {
  createRecentlyClosedTabPositionIndex,
  getRecentlyClosedTabPosition,
  insertTabAtRecentlyClosedPosition,
  restoreRecentlyClosedTabPosition
} from './recently-closed-tab-position'
export type {
  RecentlyClosedTabPosition,
  RecentlyClosedTabPositionIndex
} from './recently-closed-tab-position'

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

export type RecentlyClosedTabKind = 'terminal' | 'browser' | 'editor'

const MAX_RECENT_CLOSED_TERMINAL_TABS = 10
// Why: wider than the per-type stacks (10) so cross-type ordering survives a
// full per-type stack; kind entries whose snapshot aged out are skipped on pop.
const MAX_RECENT_CLOSED_TAB_KINDS = 30

// Why: the map params tolerate undefined because several test harnesses build
// partial stores (single-slice spreads) that lack this slice's state.
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

export function pushRecentlyClosedTabKind(
  map: Record<string, RecentlyClosedTabKind[]> | undefined,
  worktreeId: string,
  kind: RecentlyClosedTabKind,
  count = 1
): Record<string, RecentlyClosedTabKind[]> {
  // Why: preserve the original reference on no-op pushes so unrelated
  // subscribers don't re-evaluate (mirrors the closeTab unread-map pattern).
  if (count <= 0) {
    return map ?? {}
  }
  // Why: close-all may contain thousands of editor tabs, but entries beyond
  // the retained history cap can never affect reopen ordering.
  const retainedCount = Math.min(count, MAX_RECENT_CLOSED_TAB_KINDS)
  return {
    ...map,
    [worktreeId]: [
      ...(Array(retainedCount).fill(kind) as RecentlyClosedTabKind[]),
      ...(map?.[worktreeId] ?? [])
    ].slice(0, MAX_RECENT_CLOSED_TAB_KINDS)
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

export type RecentlyClosedTabsSlice = {
  /** Newest-first snapshots of user-closed terminal tabs, per worktree. */
  recentlyClosedTerminalTabsByWorktree: Record<string, ClosedTerminalTabSnapshot[]>
  /** Newest-first close order across the terminal/browser/editor reopen stacks
   *  so Cmd+Shift+T pops true cross-type MRU (Chrome/Ghostty semantics). */
  recentlyClosedTabKindsByWorktree: Record<string, RecentlyClosedTabKind[]>
  reopenClosedTerminalTab: (worktreeId: string) => boolean
  reopenClosedTab: (worktreeId: string) => boolean
}

export const createRecentlyClosedTabsSlice: StateCreator<
  AppState,
  [],
  [],
  RecentlyClosedTabsSlice
> = (set, get) => ({
  recentlyClosedTerminalTabsByWorktree: {},
  recentlyClosedTabKindsByWorktree: {},

  reopenClosedTerminalTab: (worktreeId) => {
    // Why: explicitly remote-owned worktrees own terminals through the host
    // session. A raw local createTab here would leave an
    // unbacked phantom tab that races the next host snapshot, so skip local
    // reopen for those worktrees — the cross-type dispatcher falls through to
    // browser/editor. Imported directly instead of via web-runtime-session to
    // avoid a store slice ↔ store-index import cycle. Remote terminal reopen is
    // deferred (see PR notes); local + SSH worktrees are the covered surface.
    if (getExplicitRuntimeEnvironmentIdForWorktree(get(), worktreeId)?.trim()) {
      return false
    }
    // Why: read and pop atomically inside set() to prevent a TOCTOU race where
    // two rapid Cmd+Shift+T presses both restore the same entry (mirrors
    // reopenClosedBrowserTab).
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
    get().setActiveTabType('terminal')
    restoreRecentlyClosedTabPosition(get, worktreeId, tab.id, snapshot.position)
    return true
  },

  reopenClosedTab: (worktreeId) => {
    // Why: a kind entry can outlive its snapshot (per-type caps are tighter,
    // and the browser stack dedupes by workspace id), so skip drained kinds
    // instead of giving up. Each iteration shifts one entry, so the loop is
    // bounded by the kind list length.
    for (;;) {
      let kind: RecentlyClosedTabKind | undefined
      set((s) => {
        const kinds = s.recentlyClosedTabKindsByWorktree[worktreeId] ?? []
        kind = kinds[0]
        if (!kind) {
          return s
        }
        return {
          recentlyClosedTabKindsByWorktree: {
            ...s.recentlyClosedTabKindsByWorktree,
            [worktreeId]: kinds.slice(1)
          }
        }
      })
      if (!kind) {
        return false
      }
      const reopened =
        kind === 'terminal'
          ? get().reopenClosedTerminalTab(worktreeId)
          : kind === 'browser'
            ? get().reopenClosedBrowserTab(worktreeId) !== null
            : get().reopenClosedEditorTab(worktreeId)
      if (reopened) {
        return true
      }
    }
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
        : resolveTuiAgentLaunchArgs(snapshot.agent, state.settings?.agentDefaultArgs),
    agentEnv:
      launchConfig !== undefined
        ? launchConfig.agentEnv
        : resolveTuiAgentLaunchEnv(snapshot.agent, state.settings?.agentDefaultEnv),
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
  get().setActiveTabType('terminal')
  // Why: prefer main's closed-tab position restore when captured; fall back to
  // append so agent resume still works on older snapshots without position.
  if (snapshot.position) {
    restoreRecentlyClosedTabPosition(get, worktreeId, tab.id, snapshot.position)
  } else {
    appendTabToBarOrder(get, worktreeId, tab.id)
  }
  return true
}
