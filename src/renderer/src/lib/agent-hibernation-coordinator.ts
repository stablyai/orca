import { useAppStore } from '@/store'
import {
  getEffectiveAgentHibernationIdleMs,
  planAgentHibernationCandidates,
  type AgentHibernationCandidate,
  type AgentHibernationPlannerSnapshot
} from './agent-hibernation-planner'
import {
  confirmAgentHibernationCandidates,
  type AgentHibernationConfirmationState
} from './agent-hibernation-confirmation'
import type { AppState } from '@/store/types'
import { getAllDrivers } from './pane-manager/mobile-driver-state'
import {
  getForegroundTerminalTabIds,
  getForegroundTerminalTabLastSeenAtById
} from './foreground-terminal-tabs'
import { getAgentHibernationOutputSignature } from './agent-hibernation-output-activity'
import {
  getHibernationBoundaryResolvedAtByPaneKey,
  getHibernationPtyBindingFirstSeenAtByPaneKey,
  observeHibernationPtyBindings
} from './agent-hibernation-pane-age'
import { mergePendingTerminalInputActivity } from './terminal-input-activity-coalescing'
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
  shuttingDownCandidateIds: Set<string>
  now: () => number
}

const coordinator: AgentHibernationCoordinatorState = {
  interval: null,
  confirmationState: {},
  tickInFlight: false,
  shuttingDownCandidateIds: new Set(),
  now: () => Date.now()
}

type RuntimePtyLivenessSample = {
  runtimeLivePtyIdsByWorktreeId: Record<string, string[]>
  runtimeLivenessRequiredWorktreeIds: string[]
}

function snapshotFromState(
  state: AppState,
  now: number,
  runtimeLiveness: RuntimePtyLivenessSample,
  targetWorktreeId?: string
): AgentHibernationPlannerSnapshot {
  return {
    settings: state.settings,
    activeWorktreeId: state.activeWorktreeId,
    foregroundTerminalTabIds: getForegroundTerminalTabIds(),
    tabsByWorktree: targetWorktreeId
      ? { [targetWorktreeId]: state.tabsByWorktree[targetWorktreeId] ?? [] }
      : state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    runtimeLivePtyIdsByWorktreeId: runtimeLiveness.runtimeLivePtyIdsByWorktreeId,
    runtimeLivenessRequiredWorktreeIds: runtimeLiveness.runtimeLivenessRequiredWorktreeIds,
    mobileLockedPtyIds: [...getAllDrivers()]
      .filter(([, driver]) => driver.kind === 'mobile')
      .map(([ptyId]) => ptyId),
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    // Why: input stamps are coalesced, so planning must see the not-yet-flushed keystroke.
    lastTerminalInputAtByPaneKey: mergePendingTerminalInputActivity(
      state.lastTerminalInputAtByPaneKey
    ),
    foregroundTerminalLastSeenAtByTabId: getForegroundTerminalTabLastSeenAtById(),
    ptyBindingFirstSeenAtByPaneKey: getHibernationPtyBindingFirstSeenAtByPaneKey(),
    boundaryResolvedAtByPaneKey: getHibernationBoundaryResolvedAtByPaneKey(),
    now
  }
}

function getRuntimeLivenessTargetWorktrees(
  state: AppState,
  targetWorktreeId?: string
): Map<string, string> {
  const targets = new Map<string, string>()
  const worktreeIds = targetWorktreeId
    ? Object.hasOwn(state.tabsByWorktree, targetWorktreeId)
      ? [targetWorktreeId]
      : []
    : Object.keys(state.tabsByWorktree)
  for (const worktreeId of worktreeIds) {
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

async function collectRuntimePtyLiveness(
  state: AppState,
  targetWorktreeId?: string
): Promise<RuntimePtyLivenessSample> {
  const targets = getRuntimeLivenessTargetWorktrees(state, targetWorktreeId)
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
            requireFreshPtyLiveness: true,
            includeVisualLayouts: false
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

async function currentCandidates(now: number, targetWorktreeId?: string) {
  const runtimeLiveness = await collectRuntimePtyLiveness(useAppStore.getState(), targetWorktreeId)
  const freshState = useAppStore.getState()
  // Why: age the PTY bindings from the same state the plan is built from, so a pane
  // observed for the first time this pass cannot also be judged long-idle in it.
  observeHibernationPtyBindings({
    tabsByWorktree: freshState.tabsByWorktree,
    terminalLayoutsByTabId: freshState.terminalLayoutsByTabId,
    now,
    idleMs: getEffectiveAgentHibernationIdleMs(freshState.settings?.agentHibernationIdleMs)
  })
  return planAgentHibernationCandidates(
    snapshotFromState(freshState, now, runtimeLiveness, targetWorktreeId)
  )
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

async function hibernatePaneIfStillEligible(
  confirmedCandidate: AgentHibernationCandidate
): Promise<void> {
  const { id, worktreeId } = confirmedCandidate
  if (coordinator.shuttingDownCandidateIds.has(id)) {
    return
  }
  // Why: the confirmed pane can only be authorized by its owning worktree. A
  // global sweep here made C pane teardowns issue C×W fresh runtime listings.
  const candidates = await currentCandidates(coordinator.now(), worktreeId)
  const stillEligible = candidates.some(
    (candidate) =>
      candidate.id === confirmedCandidate.id && candidate.signature === confirmedCandidate.signature
  )
  if (!stillEligible) {
    return
  }
  coordinator.shuttingDownCandidateIds.add(id)
  try {
    const state = useAppStore.getState()
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    await state.shutdownCompletedAgentPaneForHibernation(worktreeId, {
      paneKey: confirmedCandidate.paneKey,
      tabId: confirmedCandidate.tabId,
      leafId: confirmedCandidate.leafId,
      ptyId: confirmedCandidate.targetPtyIds[0],
      ...(runtimeEnvironmentId
        ? { expectedRuntimePtyId: confirmedCandidate.expectedRuntimePtyIds[0] }
        : {})
    })
  } catch (err) {
    console.warn('[agent-hibernation] failed to hibernate agent pane:', id, err)
  } finally {
    coordinator.shuttingDownCandidateIds.delete(id)
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
    // Why: drain sequentially. Each shutdown re-runs a full runtime-liveness sweep and
    // then a stopExact RPC, so firing the whole confirmed set at once meant ~100
    // concurrent sweeps plus ~100 concurrent stops on the first pass after a backlog —
    // hundreds of near-simultaneous RPCs on an SSH runtime. Awaiting also makes
    // `tickInFlight` actually cover the drain; unawaited, it was cleared the moment the
    // promises were launched. Each candidate re-validates against a fresh plan at its own
    // turn, so a slow drain cannot act on stale confirmation.
    for (const candidate of plan.candidates) {
      await hibernatePaneIfStillEligible(candidate)
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

export function resetAgentHibernationCoordinatorForTests(): void {
  stopAgentHibernationCoordinator()
  coordinator.shuttingDownCandidateIds.clear()
  coordinator.tickInFlight = false
  coordinator.now = () => Date.now()
}
