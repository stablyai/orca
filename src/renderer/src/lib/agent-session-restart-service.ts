import { useAppStore } from '@/store'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { ptyDataHandlers } from '@/components/terminal-pane/pty-dispatcher'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/mounted-terminal-tab-registry'
import { filterEnabledTuiAgents } from '../../../shared/tui-agent-selection'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { normalizeAgentProviderSession } from '../../../shared/agent-session-resume'
import type { AppState } from '@/store'
import { collectAgentSessionRestartPlan } from './agent-session-restart-collect'
import {
  agentSessionRestartFenceHolds,
  type AgentSessionRestartFence,
  type AgentSessionRestartPane,
  type AgentSessionRestartPlan
} from './agent-session-restart-plan'
import {
  createAgentSessionRestartController,
  type AgentSessionRestartController
} from './agent-session-restart-controller'
import { runAgentSessionRestartTargets } from './agent-session-restart-run'
import { buildAgentSessionRestartStartup } from './agent-session-restart-startup'
import {
  getMountedAgentSessionRestart,
  setMountedAgentSessionRestartListener
} from './agent-session-restart-mounted'
import {
  spawnMountedAgentSessionRestart,
  spawnUnmountedAgentSessionRestart
} from './agent-session-restart-spawn'
import type { AgentSessionRestartPlacement } from './agent-session-restart-run'

let controller: AgentSessionRestartController | null = null
let promoteQueued = false

export function setAgentSessionRestartControllerForTests(
  next: AgentSessionRestartController | null
): void {
  controller = next
  promoteQueued = false
}

export function getAgentSessionRestartController(): AgentSessionRestartController {
  controller ??= createAgentSessionRestartController({
    plan: () => collectAgentSessionRestartPlanFromState(useAppStore.getState()),
    run: (targets) => runAgentSessionRestartTargets(targets, runDeps())
  })
  return controller
}

export function collectAgentSessionRestartPlanFromState(state: AppState): AgentSessionRestartPlan {
  const enabledCatalog = filterEnabledTuiAgents(
    getAgentCatalog().map((entry) => entry.id),
    state.settings?.disabledTuiAgents
  )
  return collectAgentSessionRestartPlan({
    tabsByWorktree: state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    shellForeground: (paneKey) =>
      state.paneForegroundAgentByPaneKey?.[paneKey]?.shellForeground === true,
    ompResumeFilePath: (paneKey) => {
      const entry = state.agentStatusByPaneKey[paneKey]
      return entry
        ? (state.getAgentLaunchConfigForStatusEntry(entry)?.ompResumeFilePath ?? null)
        : null
    },
    startupUnavailableReason: (pane) => {
      const entry = state.agentStatusByPaneKey[makePaneKey(pane.tabId, pane.leafId)]
      if (!entry || !normalizeAgentProviderSession(entry.providerSession)) {
        return undefined
      }
      if (!state.getAgentLaunchConfigForStatusEntry(entry)) {
        return 'unknown-launch'
      }
      if (!isTuiAgent(pane.agent)) {
        return undefined
      }
      const tab = state.tabsByWorktree[pane.worktreeId]?.find((item) => item.id === pane.tabId)
      return buildAgentSessionRestartStartup(pane.agent, {
        tabId: pane.tabId,
        leafId: pane.leafId,
        worktreeId: pane.worktreeId,
        shellOverride: tab?.shellOverride
      })
        ? undefined
        : 'resume-unavailable'
    },
    enabledCatalog,
    workspaceLabel: (worktreeId) =>
      state.getKnownWorktreeById(worktreeId)?.displayName || worktreeId,
    executionHostId: (worktreeId) => getKnownExecutionHostIdForWorktree(state, worktreeId),
    wsl: (worktreeId) => {
      const runtime = getLocalProjectExecutionRuntimeContext(state, worktreeId)
      return runtime?.status === 'resolved' && runtime.runtime.kind === 'wsl'
    }
  })
}

/** Installed once at app startup. Promotes queued restarts when a pane becomes idle or mounts. */
export function installAgentSessionRestartPromoter(): () => void {
  const active = getAgentSessionRestartController()
  setMountedAgentSessionRestartListener(() => schedulePromote(active))
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (!active.hasWaiting()) {
      return
    }
    if (
      state.agentStatusByPaneKey !== previous.agentStatusByPaneKey ||
      state.tabsByWorktree !== previous.tabsByWorktree ||
      state.terminalLayoutsByTabId !== previous.terminalLayoutsByTabId ||
      state.ptyIdsByTabId !== previous.ptyIdsByTabId
    ) {
      schedulePromote(active)
    }
  })
  return () => {
    unsubscribe()
    setMountedAgentSessionRestartListener(null)
  }
}

function schedulePromote(active: AgentSessionRestartController): void {
  // A request seeds queued panes before spawn, so a status change during the batch is not lost.
  if (promoteQueued || (!active.hasWaiting() && !active.isRunning())) {
    return
  }
  promoteQueued = true
  queueMicrotask(() => {
    promoteQueued = false
    void active.promote().catch((err) => {
      console.warn('[session-restart] promote failed:', err)
    })
  })
}

function runDeps() {
  return {
    revalidate: revalidateFence,
    readiness: readinessForPane,
    buildStartup: (target: { pane: AgentSessionRestartPane }) => {
      if (!isTuiAgent(target.pane.agent)) {
        return null
      }
      const tab = useAppStore
        .getState()
        .tabsByWorktree[target.pane.worktreeId]?.find((item) => item.id === target.pane.tabId)
      return buildAgentSessionRestartStartup(target.pane.agent, {
        tabId: target.pane.tabId,
        leafId: target.pane.leafId,
        worktreeId: target.pane.worktreeId,
        shellOverride: tab?.shellOverride
      })
    },
    placement: placementForPane,
    spawnMounted: spawnMountedAgentSessionRestart,
    spawnUnmounted: spawnUnmountedAgentSessionRestart
  }
}

function readinessForPane(pane: AgentSessionRestartPane): 'ready' | 'busy' | 'blocked' {
  const entry = useAppStore.getState().agentStatusByPaneKey[makePaneKey(pane.tabId, pane.leafId)]
  if (!entry || entry.state === 'done') {
    return 'ready'
  }
  return entry.state === 'blocked' ? 'blocked' : 'busy'
}

function placementForPane(pane: AgentSessionRestartPane): AgentSessionRestartPlacement {
  if (getMountedAgentSessionRestart(pane.ptyId)) {
    return 'mounted'
  }
  // An open terminal that has not registered yet must not be replaced by a hidden spawn.
  if (
    ptyDataHandlers.has(pane.ptyId) ||
    hasRegisteredRuntimeTerminalTab(pane.tabId, pane.worktreeId)
  ) {
    return 'open-unready'
  }
  return 'unmounted'
}

function revalidateFence(fence: AgentSessionRestartFence) {
  const state = useAppStore.getState()
  const tab = state.tabsByWorktree[fence.worktreeId]?.find((item) => item.id === fence.tabId)
  if (!tab) {
    return 'removed' as const
  }
  const entry = state.agentStatusByPaneKey[makePaneKey(fence.tabId, fence.leafId)]
  const session = normalizeAgentProviderSession(entry?.providerSession)
  const holds = agentSessionRestartFenceHolds(fence, {
    ptyBoundToTab: (state.ptyIdsByTabId[fence.tabId] ?? []).includes(fence.ptyId),
    leafPtyId: state.terminalLayoutsByTabId[fence.tabId]?.ptyIdsByLeafId?.[fence.leafId] ?? null,
    tabGeneration: tab.generation ?? 0,
    agent: typeof entry?.agentType === 'string' ? entry.agentType : null,
    providerSessionId: session?.id ?? null,
    providerSessionKey: session?.key ?? null,
    transcriptPath: session?.transcriptPath ?? null,
    ompResumeFilePath: entry
      ? (state.getAgentLaunchConfigForStatusEntry(entry)?.ompResumeFilePath ?? null)
      : null,
    worktreeId: tab.worktreeId
  })
  return holds ? ('ok' as const) : ('pane-changed' as const)
}
