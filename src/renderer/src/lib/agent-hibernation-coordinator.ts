import { useAppStore } from '@/store'
import {
  confirmAgentHibernationCandidates,
  planAgentHibernationCandidates,
  type AgentHibernationCandidate,
  type AgentHibernationConfirmationState,
  type AgentHibernationPlannerSnapshot
} from './agent-hibernation-planner'
import type { AppState } from '@/store/types'
import { getAllDrivers } from './pane-manager/mobile-driver-state'
import { getForegroundTerminalWorktreeIds } from './foreground-terminal-worktrees'
import { getAgentHibernationOutputSignature } from './agent-hibernation-output-activity'

export const AGENT_HIBERNATION_TICK_MS = 60 * 1000

type IntervalHandle = ReturnType<typeof setInterval>

type AgentHibernationCoordinatorOptions = {
  intervalMs?: number
  now?: () => number
}

type AgentHibernationCoordinatorState = {
  interval: IntervalHandle | null
  confirmationState: AgentHibernationConfirmationState
  shuttingDownWorktreeIds: Set<string>
  now: () => number
}

const coordinator: AgentHibernationCoordinatorState = {
  interval: null,
  confirmationState: {},
  shuttingDownWorktreeIds: new Set(),
  now: () => Date.now()
}

function snapshotFromState(state: AppState, now: number): AgentHibernationPlannerSnapshot {
  return {
    settings: state.settings,
    activeWorktreeId: state.activeWorktreeId,
    foregroundWorktreeIds: getForegroundTerminalWorktreeIds(),
    tabsByWorktree: state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    mobileLockedPtyIds: [...getAllDrivers()]
      .filter(([, driver]) => driver.kind === 'mobile')
      .map(([ptyId]) => ptyId),
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    lastTerminalInputAtByPaneKey: state.lastTerminalInputAtByPaneKey,
    now
  }
}

function currentCandidates(now: number) {
  return planAgentHibernationCandidates(snapshotFromState(useAppStore.getState(), now)).map(
    (candidate) => ({
      ...candidate,
      // Why: terminal output after the first stable tick can mean the session
      // is still alive even when agent status remains done; require it to stay quiet.
      signature: `${candidate.signature}|output:${getAgentHibernationOutputSignature(candidate.paneKeys)}`
    })
  )
}

async function hibernateWorktreeIfStillEligible(
  confirmedCandidate: AgentHibernationCandidate
): Promise<void> {
  const { worktreeId } = confirmedCandidate
  if (coordinator.shuttingDownWorktreeIds.has(worktreeId)) {
    return
  }
  const candidates = currentCandidates(coordinator.now())
  const stillEligible = candidates.some(
    (candidate) =>
      candidate.worktreeId === worktreeId && candidate.signature === confirmedCandidate.signature
  )
  if (!stillEligible) {
    return
  }
  coordinator.shuttingDownWorktreeIds.add(worktreeId)
  try {
    await useAppStore.getState().shutdownWorktreeTerminals(worktreeId, {
      keepIdentifiers: true,
      sleepingPaneKeys: confirmedCandidate.paneKeys
    })
  } catch (err) {
    console.warn('[agent-hibernation] failed to hibernate worktree:', worktreeId, err)
  } finally {
    coordinator.shuttingDownWorktreeIds.delete(worktreeId)
  }
}

export function runAgentHibernationTick(): void {
  const plan = confirmAgentHibernationCandidates(
    coordinator.confirmationState,
    currentCandidates(coordinator.now())
  )
  coordinator.confirmationState = plan.confirmationState
  for (const candidate of plan.candidates) {
    void hibernateWorktreeIfStillEligible(candidate)
  }
}

export function startAgentHibernationCoordinator(
  options: AgentHibernationCoordinatorOptions = {}
): () => void {
  if (coordinator.interval !== null) {
    return stopAgentHibernationCoordinator
  }
  coordinator.now = options.now ?? (() => Date.now())
  const intervalMs = options.intervalMs ?? AGENT_HIBERNATION_TICK_MS
  coordinator.interval = setInterval(runAgentHibernationTick, intervalMs)
  return stopAgentHibernationCoordinator
}

export function stopAgentHibernationCoordinator(): void {
  if (coordinator.interval !== null) {
    clearInterval(coordinator.interval)
    coordinator.interval = null
  }
  coordinator.confirmationState = {}
}

export function isAgentHibernationCoordinatorRunning(): boolean {
  return coordinator.interval !== null
}

export function resetAgentHibernationCoordinatorForTests(): void {
  stopAgentHibernationCoordinator()
  coordinator.shuttingDownWorktreeIds.clear()
  coordinator.now = () => Date.now()
}
