import { createDashboardChatProgramHolds } from './dashboard-chat-program-acquisition'
import { useEffect } from 'react'
import { useAppStore, type AppState } from '@/store'
import { subscribeChatProgramFacts } from '@/lib/host-chat-program'
import {
  type AgentLaunchRouteView,
  agentLaunchRouteInputsChanged,
  selectAgentLaunchRouteView
} from '@/lib/agent-launch-route-input'
import { revealDashboardAgent } from './reveal-dashboard-agent'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { buildDashboardSnapshot, type DashboardSnapshotState } from './build-dashboard-snapshot'
import { createWorktreeAgentRowsCache } from './worktree-agent-rows-cache'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

// Throttle cross-worktree snapshot rebuilds to 4Hz during agent-status bursts.
const PUBLISH_THROTTLE_MS = 250

/** Compare immutable icon references before recloning data URLs; unchanged maps can otherwise resend megabytes at 4Hz. */
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

type DashboardSnapshotWatchState = DashboardSnapshotState &
  Pick<AppState, 'agentStatusEpoch'> &
  AgentLaunchRouteView

export function dashboardSnapshotInputsChanged(
  state: DashboardSnapshotWatchState,
  previousState: DashboardSnapshotWatchState
): boolean {
  return (
    agentLaunchRouteInputsChanged(state, previousState) ||
    state.repos !== previousState.repos ||
    selectWorktreesByRepo(state) !== selectWorktreesByRepo(previousState) ||
    state.tabsByWorktree !== previousState.tabsByWorktree ||
    state.unifiedTabsByWorktree !== previousState.unifiedTabsByWorktree ||
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
    // Relay live hooks directly; rebuild snapshots for host-profile changes too, since idle boards may have no later event to correct stale byte routing.
    state.sshConnectionStates !== previousState.sshConnectionStates ||
    state.sshStateByEnvironment !== previousState.sshStateByEnvironment ||
    state.runtimeStatusByEnvironmentId !== previousState.runtimeStatusByEnvironmentId ||
    state.paneForegroundAgentByPaneKey !== previousState.paneForegroundAgentByPaneKey ||
    state.detectedWorktreesByRepo !== previousState.detectedWorktreesByRepo ||
    // Folder workspace ownership uses folderWorkspaces/projectGroups rather than git-worktree rows.
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

/** Keep subscription outside the effect to avoid react-doctor’s cleanup false positive; callers must invoke the returned disposer. */
export function watchSnapshotInputs(onChanged: () => void): () => void {
  const unsubscribeStore = useAppStore.subscribe((state, previousState) => {
    // Why: unrelated high-frequency store writes must not rebuild a cross-worktree snapshot.
    if (dashboardSnapshotInputsChanged(state, previousState)) {
      onChanged()
    }
  })
  // Launch options also read host chat facts held outside the store.
  const unsubscribeChatFacts = subscribeChatProgramFacts(onChanged)
  return () => {
    unsubscribeStore()
    unsubscribeChatFacts()
  }
}

/** Mount once in main to publish snapshots only while pop-out is open and handle relayed pane-reveal requests. */
export function useDashboardPopoutBridge(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    return window.api.dashboard.onRevealAgent((args) => {
      revealDashboardAgent(args)
    })
  }, [enabled])

  // Apply shared read acknowledgments here; optional IPC tolerates dev-HMR preload skew until restart.
  useEffect(() => {
    if (!enabled) {
      return
    }
    return window.api.dashboard.onAckAgent?.((paneKey, intent) => {
      useAppStore.getState().acknowledgeAgents([paneKey], undefined, intent)
    })
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      return
    }
    let open = false
    let disposed = false
    const chatOwners = createDashboardChatProgramHolds()
    let unsubscribeStore: (() => void) | null = null
    let trailingTimer: ReturnType<typeof setTimeout> | null = null
    let lastPublishAt = 0
    let lastPublishedRepoIcons: Record<string, RepoIcon | null> | null = null

    // Force icons for new/requesting windows; throttle-time omissions retain their map. Cache worktree rows per bridge lifecycle.
    const rowsCache = createWorktreeAgentRowsCache()
    const publishNow = (withIcons: boolean): void => {
      lastPublishAt = Date.now()
      const state = useAppStore.getState()
      chatOwners.reconcile(state)
      const snapshot = buildDashboardSnapshot(state, lastPublishAt, {
        launchRouteStore: selectAgentLaunchRouteView(state),
        rowsCache,
        rowsGeneration: state.agentStatusEpoch
      })
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
        chatOwners.release()
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
    // Recover an already-open pop-out after the main renderer reloads.
    void window.api.dashboard.getPopoutOpen().then((isOpen) => {
      if (!disposed && isOpen) {
        setOpen(true)
      }
    })

    return () => {
      disposed = true
      chatOwners.release()
      offOpenChanged?.()
      offRequested?.()
      unsubscribeStore?.()
      if (trailingTimer) {
        clearTimeout(trailingTimer)
      }
    }
  }, [enabled])
}
