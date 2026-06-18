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
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../shared/runtime-types'

export const AGENT_HIBERNATION_TICK_MS = 60 * 1000

type IntervalHandle = ReturnType<typeof setInterval>

type AgentHibernationCoordinatorOptions = {
  intervalMs?: number
  now?: () => number
}

type AgentHibernationCoordinatorState = {
  interval: IntervalHandle | null
  confirmationState: AgentHibernationConfirmationState
  tickInFlight: boolean
  shuttingDownWorktreeIds: Set<string>
  now: () => number
}

const coordinator: AgentHibernationCoordinatorState = {
  interval: null,
  confirmationState: {},
  tickInFlight: false,
  shuttingDownWorktreeIds: new Set(),
  now: () => Date.now()
}

type RuntimePtyLivenessSample = {
  runtimeLivePtyIdsByWorktreeId: Record<string, string[]>
  runtimeLivenessRequiredWorktreeIds: string[]
}

function snapshotFromState(
  state: AppState,
  now: number,
  runtimeLiveness: RuntimePtyLivenessSample
): AgentHibernationPlannerSnapshot {
  return {
    settings: state.settings,
    activeWorktreeId: state.activeWorktreeId,
    foregroundWorktreeIds: getForegroundTerminalWorktreeIds(),
    tabsByWorktree: state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    runtimeLivePtyIdsByWorktreeId: runtimeLiveness.runtimeLivePtyIdsByWorktreeId,
    runtimeLivenessRequiredWorktreeIds: runtimeLiveness.runtimeLivenessRequiredWorktreeIds,
    mobileLockedPtyIds: [...getAllDrivers()]
      .filter(([, driver]) => driver.kind === 'mobile')
      .map(([ptyId]) => ptyId),
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    lastTerminalInputAtByPaneKey: state.lastTerminalInputAtByPaneKey,
    now
  }
}

function getRuntimeLivenessTargetWorktrees(state: AppState): Map<string, string> {
  const targets = new Map<string, string>()
  for (const worktreeId of Object.keys(state.tabsByWorktree)) {
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    if (runtimeEnvironmentId) {
      targets.set(worktreeId, runtimeEnvironmentId)
    }
  }
  return targets
}

function getTypedRuntimePtyId(terminal: RuntimeTerminalSummary): string | null {
  if (terminal.ptyId) {
    return terminal.ptyId
  }
  if (terminal.tabId.startsWith('pty:') && terminal.tabId === terminal.leafId) {
    return terminal.tabId.slice('pty:'.length) || null
  }
  return null
}

async function collectRuntimePtyLiveness(state: AppState): Promise<RuntimePtyLivenessSample> {
  const targets = getRuntimeLivenessTargetWorktrees(state)
  const runtimeLivePtyIdsByWorktreeId: Record<string, string[]> = {}
  const runtimeLivenessRequiredWorktreeIds = [...targets.keys()]
  await Promise.all(
    [...targets].map(async ([worktreeId, runtimeEnvironmentId]) => {
      try {
        const result = await callRuntimeRpc<RuntimeTerminalListResult>(
          { kind: 'environment', environmentId: runtimeEnvironmentId },
          'terminal.list',
          {
            worktree: toRuntimeWorktreeSelector(worktreeId),
            limit: 10_000,
            requireFreshPtyLiveness: true
          },
          { timeoutMs: 10_000 }
        )
        if (result.truncated) {
          return
        }
        const ptyIds = new Set<string>()
        for (const terminal of result.terminals) {
          if (!terminal.connected || terminal.worktreeId !== worktreeId) {
            continue
          }
          const ptyId = getTypedRuntimePtyId(terminal)
          if (ptyId) {
            ptyIds.add(ptyId)
          }
        }
        runtimeLivePtyIdsByWorktreeId[worktreeId] = [...ptyIds].sort()
      } catch {
        // Why: stale runtime liveness is unsafe for all-or-nothing hibernation;
        // omitting the worktree makes the planner fail closed for this pass.
      }
    })
  )
  return { runtimeLivePtyIdsByWorktreeId, runtimeLivenessRequiredWorktreeIds }
}

async function currentCandidates(now: number) {
  const runtimeLiveness = await collectRuntimePtyLiveness(useAppStore.getState())
  const freshState = useAppStore.getState()
  return planAgentHibernationCandidates(snapshotFromState(freshState, now, runtimeLiveness))
    .filter((candidate) => {
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
        freshState,
        candidate.worktreeId
      )
      return !runtimeEnvironmentId || candidate.expectedRuntimePtyIds.length === 1
    })
    .map((candidate) => ({
      ...candidate,
      // Why: terminal output after the first stable tick can mean the session
      // is still alive even when agent status remains done; require it to stay quiet.
      signature: `${candidate.signature}|output:${getAgentHibernationOutputSignature(candidate.paneKeys)}`
    }))
}

async function hibernateWorktreeIfStillEligible(
  confirmedCandidate: AgentHibernationCandidate
): Promise<void> {
  const { worktreeId } = confirmedCandidate
  if (coordinator.shuttingDownWorktreeIds.has(worktreeId)) {
    return
  }
  const candidates = await currentCandidates(coordinator.now())
  const stillEligible = candidates.some(
    (candidate) =>
      candidate.worktreeId === worktreeId && candidate.signature === confirmedCandidate.signature
  )
  if (!stillEligible) {
    return
  }
  coordinator.shuttingDownWorktreeIds.add(worktreeId)
  try {
    const state = useAppStore.getState()
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    await state.shutdownWorktreeTerminals(worktreeId, {
      keepIdentifiers: true,
      shutdownReason: 'auto-hibernate-completed-agent',
      sleepingPaneKeys: confirmedCandidate.paneKeys,
      ...(runtimeEnvironmentId
        ? { expectedRuntimePtyIds: confirmedCandidate.expectedRuntimePtyIds }
        : {})
    })
  } catch (err) {
    console.warn('[agent-hibernation] failed to hibernate worktree:', worktreeId, err)
  } finally {
    coordinator.shuttingDownWorktreeIds.delete(worktreeId)
  }
}

export async function runAgentHibernationTick(): Promise<void> {
  if (coordinator.tickInFlight) {
    return
  }
  coordinator.tickInFlight = true
  try {
    const plan = confirmAgentHibernationCandidates(
      coordinator.confirmationState,
      await currentCandidates(coordinator.now())
    )
    coordinator.confirmationState = plan.confirmationState
    for (const candidate of plan.candidates) {
      void hibernateWorktreeIfStillEligible(candidate)
    }
  } finally {
    coordinator.tickInFlight = false
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
  coordinator.interval = setInterval(() => void runAgentHibernationTick(), intervalMs)
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
  coordinator.tickInFlight = false
  coordinator.now = () => Date.now()
}
