import { useEffect } from 'react'
import { useAppStore, type AppState } from '@/store'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { runSleepWorktree } from '../sidebar/sleep-worktree-flow'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { buildDashboardSnapshot, type DashboardSnapshotState } from './build-dashboard-snapshot'
import { launchDashboardAgent } from './launch-dashboard-agent'
import { openDashboardFileLink } from './open-dashboard-file-link'

// Why: cap snapshot rebuilds during bursts of agent-status pings. The board is a
// glanceable surface, so ~4 updates/sec is plenty and keeps the cross-worktree
// rebuild off the hot path.
const PUBLISH_THROTTLE_MS = 250

/**
 * Repo icons are the only unbounded field on the snapshot — an image icon is a
 * data URL capped at MAX_REPO_ICON_DATA_URL_LENGTH (400KB), and every repo that
 * contributes a card ships one. They change about never, but the snapshot
 * republishes up to 4x/sec while the pop-out is open, so re-sending them was
 * structured-cloning megabytes per second across the window boundary for bytes
 * the pop-out already had.
 *
 * Compare by reference: icons come off immutable store repo records, so an
 * unchanged repo yields the identical object.
 */
export function repoIconsUnchanged(
  next: Record<string, RepoIcon | null>,
  previous: Record<string, RepoIcon | null> | null
): boolean {
  if (!previous) {
    return false
  }
  const nextIds = Object.keys(next)
  if (nextIds.length !== Object.keys(previous).length) {
    return false
  }
  return nextIds.every((id) => id in previous && next[id] === previous[id])
}

type DashboardSnapshotWatchState = DashboardSnapshotState & Pick<AppState, 'agentStatusEpoch'>

export function dashboardSnapshotInputsChanged(
  state: DashboardSnapshotWatchState,
  previousState: DashboardSnapshotWatchState
): boolean {
  return (
    state.repos !== previousState.repos ||
    state.worktreesByRepo !== previousState.worktreesByRepo ||
    state.tabsByWorktree !== previousState.tabsByWorktree ||
    state.retainedAgentsByPaneKey !== previousState.retainedAgentsByPaneKey ||
    state.migrationUnsupportedByPtyId !== previousState.migrationUnsupportedByPtyId ||
    state.runtimeAgentOrchestrationByPaneKey !== previousState.runtimeAgentOrchestrationByPaneKey ||
    state.terminalLayoutsByTabId !== previousState.terminalLayoutsByTabId ||
    state.ptyIdsByTabId !== previousState.ptyIdsByTabId ||
    state.runtimePaneTitlesByTabId !== previousState.runtimePaneTitlesByTabId ||
    state.acknowledgedAgentsByPaneKey !== previousState.acknowledgedAgentsByPaneKey ||
    state.hostedReviewCache !== previousState.hostedReviewCache ||
    state.prCache !== previousState.prCache ||
    // Why: settings controls idle visibility and generated conversation names.
    state.settings !== previousState.settings ||
    state.workspaceStatuses !== previousState.workspaceStatuses ||
    state.detectedAgentIds !== previousState.detectedAgentIds ||
    state.remoteDetectedAgentIds !== previousState.remoteDetectedAgentIds ||
    state.runtimeDetectedAgentIds !== previousState.runtimeDetectedAgentIds ||
    // Live hook status is relayed straight from main to the pop-out. Rebuilding
    // every card here would put map refresh work on the main renderer's hot path.
    // Why: each card carries the host-input profile its preview terminal keys
    // against, and the pop-out cannot re-derive it. Every slice that resolves
    // an execution host must republish or the preview keeps encoding bytes for
    // the host the pty used to run on — a quiet board has no later publish to
    // heal from. All are low-frequency except the foreground agent, whose churn
    // the publish throttle already absorbs.
    state.sshConnectionStates !== previousState.sshConnectionStates ||
    state.sshStateByEnvironment !== previousState.sshStateByEnvironment ||
    state.runtimeStatusByEnvironmentId !== previousState.runtimeStatusByEnvironmentId ||
    state.paneForegroundAgentByPaneKey !== previousState.paneForegroundAgentByPaneKey ||
    state.detectedWorktreesByRepo !== previousState.detectedWorktreesByRepo ||
    // Why: a folder workspace is not a git worktree — its host resolves through
    // these two instead of worktreesByRepo.
    state.folderWorkspaces !== previousState.folderWorkspaces ||
    state.projectGroups !== previousState.projectGroups ||
    state.sshTargetLabels !== previousState.sshTargetLabels ||
    state.restoredRuntimeHostIdByWorkspaceSessionKey !==
      previousState.restoredRuntimeHostIdByWorkspaceSessionKey ||
    state.runtimeEnvironments !== previousState.runtimeEnvironments ||
    state.runtimeEnvironmentCatalogHydrated !== previousState.runtimeEnvironmentCatalogHydrated ||
    state.removedRuntimeEnvironmentIds !== previousState.removedRuntimeEnvironmentIds
  )
}

/** Watches the store for snapshot-relevant writes. Lives outside the effect
 *  because react-doctor's effect-needs-cleanup false-positives on `subscribe`
 *  inside an effect body; the caller's cleanup does unsubscribe. */
function watchSnapshotInputs(onChanged: () => void): () => void {
  return useAppStore.subscribe((state, previousState) => {
    // Why: unrelated high-frequency store writes must not rebuild a cross-worktree snapshot.
    if (dashboardSnapshotInputsChanged(state, previousState)) {
      onChanged()
    }
  })
}

/**
 * Runs in the MAIN window (mount once in App). Two responsibilities:
 *  1. While the pop-out dashboard is open, derive the snapshot from the live
 *     store and publish it to the main process (which relays it to the popout).
 *     Does nothing while the popout is closed, so it's free in the common case.
 *  2. Handle click-to-focus reveal requests forwarded from the popout: activate
 *     the agent's worktree and focus its pane in this (main) window, and open
 *     files its preview terminals linkified.
 */
export function useDashboardPopoutBridge(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    return window.api.dashboard.onSpawnAgent?.(launchDashboardAgent)
  }, [enabled])

  // Sleeping from the popout runs the shared teardown here, where the store and
  // the live terminal panes are — the popout only names the workspace.
  useEffect(() => {
    if (!enabled) {
      return
    }
    return window.api.dashboard.onSleepWorkspace?.(({ worktreeId }) => {
      void runSleepWorktree(worktreeId)
    })
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      return
    }
    return window.api.dashboard.onRevealAgent((args) => {
      useAppStore.getState().setActiveWorktree(args.worktreeId, args.executionHostId)
      activateTabAndFocusPane(args.tabId, args.leafId, { flashFocusedPane: true })
    })
  }, [enabled])

  // Following a file link in a pop-out preview opens the file here, where the
  // workspace paths and the editor live.
  useEffect(() => {
    if (!enabled) {
      return
    }
    return window.api.dashboard.onOpenFile?.(openDashboardFileLink)
  }, [enabled])

  // Opening a card's terminal dialog in the popout acks the agent here — the
  // same ack the sidebar's bold/mute treatment reads, keeping both in lockstep.
  // ?. shields App mount from dev-HMR preload skew (preload updates only on
  // app restart).
  useEffect(() => {
    if (!enabled) {
      return
    }
    return window.api.dashboard.onAckAgent?.((paneKey) => {
      useAppStore.getState().acknowledgeAgents([paneKey])
    })
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      return
    }
    let open = false
    let disposed = false
    let unsubscribeStore: (() => void) | null = null
    let trailingTimer: ReturnType<typeof setTimeout> | null = null
    let lastPublishAt = 0
    let lastPublishedRepoIcons: Record<string, RepoIcon | null> | null = null

    // `withIcons` is forced whenever the pop-out could be starting from nothing —
    // it opened, or it mounted and asked. Throttled republishes omit an unchanged
    // icon map and the pop-out keeps the one it already has.
    const publishNow = (withIcons: boolean): void => {
      lastPublishAt = Date.now()
      const snapshot = buildDashboardSnapshot(useAppStore.getState(), lastPublishAt)
      const icons = snapshot.repoIconsByRepoId ?? {}
      if (!withIcons && repoIconsUnchanged(icons, lastPublishedRepoIcons)) {
        const { repoIconsByRepoId: _omitted, ...withoutIcons } = snapshot
        void window.api.dashboard.publishSnapshot(withoutIcons)
        return
      }
      lastPublishedRepoIcons = icons
      void window.api.dashboard.publishSnapshot(snapshot)
    }

    // Leading + trailing throttle so the first change paints immediately and
    // bursts collapse into one trailing publish.
    const publishThrottled = (): void => {
      if (!open || disposed) {
        return
      }
      const elapsed = Date.now() - lastPublishAt
      if (elapsed >= PUBLISH_THROTTLE_MS) {
        if (trailingTimer) {
          clearTimeout(trailingTimer)
          trailingTimer = null
        }
        publishNow(false)
        return
      }
      if (!trailingTimer) {
        trailingTimer = setTimeout(() => {
          trailingTimer = null
          if (open && !disposed) {
            publishNow(false)
          }
        }, PUBLISH_THROTTLE_MS - elapsed)
      }
    }

    const setOpen = (next: boolean): void => {
      if (next === open || disposed) {
        return
      }
      open = next
      if (open) {
        if (!unsubscribeStore) {
          unsubscribeStore = watchSnapshotInputs(publishThrottled)
        }
        publishNow(true)
      } else {
        unsubscribeStore?.()
        unsubscribeStore = null
        if (trailingTimer) {
          clearTimeout(trailingTimer)
          trailingTimer = null
        }
      }
    }

    const offOpenChanged = window.api.dashboard.onPopoutOpenChanged((next) => setOpen(next))
    // Popout mount asks for a fresh snapshot (its cached one may be stale).
    const offRequested = window.api.dashboard.onSnapshotRequested(() => {
      if (open) {
        publishNow(true)
      }
    })
    // Recover the open state when the main window (re)mounts while a pop-out is
    // already open — e.g. after a renderer reload.
    void window.api.dashboard.getPopoutOpen().then((isOpen) => {
      if (!disposed && isOpen) {
        setOpen(true)
      }
    })

    return () => {
      disposed = true
      offOpenChanged?.()
      offRequested?.()
      unsubscribeStore?.()
      if (trailingTimer) {
        clearTimeout(trailingTimer)
      }
    }
  }, [enabled])
}
