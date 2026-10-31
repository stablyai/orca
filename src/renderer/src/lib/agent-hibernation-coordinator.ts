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
import { resolveTerminalPtyOwner } from './terminal-worktree-route'
import { toAgentHibernationRuntimeOwner } from './agent-hibernation-runtime-owner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../shared/runtime-types'
import { getWindowParkVisible, subscribeWindowParkVisibility } from './window-park-visibility'
import { getEntryTabId } from './agent-hibernation-pane-eligibility'

export const AGENT_HIBERNATION_TICK_MS = 60 * 1000

type IntervalHandle = ReturnType<typeof setInterval>

type AgentHibernationCoordinatorOptions = {
  intervalMs?: number
  now?: () => number
}

type AgentHibernationCoordinatorState = {
  interval: IntervalHandle | null
  unsubscribeVisibility: (() => void) | null
  confirmationState: AgentHibernationConfirmationState
  tickInFlight: boolean
  shuttingDownCandidateIds: Set<string>
  now: () => number
}

const coordinator: AgentHibernationCoordinatorState = {
  interval: null,
  unsubscribeVisibility: null,
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
    // Union fresh owners with pre-await targets so newly resolved workspaces fail closed without host evidence; never narrow that set.
    runtimeLivenessRequiredWorktreeIds: [
      ...new Set([
        ...runtimeLiveness.runtimeLivenessRequiredWorktreeIds,
        ...getRuntimeLivenessTargetWorktrees(state, targetWorktreeId).keys()
      ])
    ],
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

function resolveAgentHibernationRuntimeOwner(state: AppState, worktreeId: string) {
  const tabs = state.tabsByWorktree[worktreeId] ?? []
  const ptyIds = tabs.flatMap((tab) => state.ptyIdsByTabId[tab.id] ?? [])
  return toAgentHibernationRuntimeOwner(resolveTerminalPtyOwner(state, worktreeId), ptyIds)
}

/** Worktree → owning runtime; `null` means liveness is required but no host can be asked. */
function getRuntimeLivenessTargetWorktrees(
  state: AppState,
  targetWorktreeId?: string
): Map<string, string | null> {
  const targets = new Map<string, string | null>()
  const worktreeIds = targetWorktreeId
    ? Object.hasOwn(state.tabsByWorktree, targetWorktreeId)
      ? [targetWorktreeId]
      : []
    : Object.keys(state.tabsByWorktree)
  for (const worktreeId of worktreeIds) {
    const owner = resolveAgentHibernationRuntimeOwner(state, worktreeId)
    if (owner.kind !== 'non-runtime') {
      targets.set(worktreeId, owner.kind === 'runtime' ? owner.environmentId : null)
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
  if (targets.size === 0) {
    // Why: an all-local install has nothing to ask, so it must not pay the status scan below.
    return { runtimeLivePtyIdsByWorktreeId, runtimeLivenessRequiredWorktreeIds }
  }
  const completedTabIds = new Set<string>()
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    const tabId = entry?.state === 'done' ? getEntryTabId(entry) : null
    if (tabId) {
      completedTabIds.add(tabId)
    }
  }
  await Promise.all(
    [...targets].map(async ([worktreeId, runtimeEnvironmentId]) => {
      if (
        !runtimeEnvironmentId ||
        !state.tabsByWorktree[worktreeId]?.some((tab) => completedTabIds.has(tab.id))
      ) {
        // Skipped owners still require host evidence if an agent completes during this pass.
        return
      }
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
        // Omit stale runtime evidence so the planner fails closed for this pass.
      }
    })
  )
  return { runtimeLivePtyIdsByWorktreeId, runtimeLivenessRequiredWorktreeIds }
}

async function currentCandidates(now: number, targetWorktreeId?: string) {
  const runtimeLiveness = await collectRuntimePtyLiveness(useAppStore.getState(), targetWorktreeId)
  const freshState = useAppStore.getState()
  // Sample binding ages from the plan’s state so a first-seen pane cannot already qualify as long-idle.
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
      const owner = resolveAgentHibernationRuntimeOwner(freshState, candidate.worktreeId)
      return (
        owner.kind === 'non-runtime' ||
        (owner.kind === 'runtime' && candidate.expectedRuntimePtyIds.length === 1)
      )
    })
    .map((candidate) => ({
      ...candidate,
      // Require output silence after the first confirmation: a done status does not prove the session stopped working.
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
  // Only the pane’s owner can authorize teardown; global sweeps cause C×W runtime listings for C candidates.
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
    const owner = resolveAgentHibernationRuntimeOwner(state, worktreeId)
    await state.shutdownCompletedAgentPaneForHibernation(worktreeId, {
      paneKey: confirmedCandidate.paneKey,
      tabId: confirmedCandidate.tabId,
      leafId: confirmedCandidate.leafId,
      ptyId: confirmedCandidate.targetPtyIds[0],
      ...(owner.kind === 'runtime'
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
    // Drain sequentially to bound liveness/stop RPCs, keep tickInFlight through completion, and revalidate each candidate against a fresh plan.
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
  coordinator.interval = setInterval(() => {
    // Reclaim only while park-visible; macOS can leave raw visibilityState stuck hidden, suppressing all later reclaim.
    if (!getWindowParkVisible()) {
      return
    }
    void runAgentHibernationTick()
  }, intervalMs)
  // Recheck on resume so two consecutive confirmations cannot span the hidden gap.
  coordinator.unsubscribeVisibility = subscribeWindowParkVisibility(() => {
    if (getWindowParkVisible()) {
      void runAgentHibernationTick()
    }
  })
  return stopAgentHibernationCoordinator
}

export function stopAgentHibernationCoordinator(): void {
  if (coordinator.interval !== null) {
    clearInterval(coordinator.interval)
    coordinator.interval = null
  }
  coordinator.unsubscribeVisibility?.()
  coordinator.unsubscribeVisibility = null
  coordinator.confirmationState = {}
}

export function resetAgentHibernationCoordinatorForTests(): void {
  stopAgentHibernationCoordinator()
  coordinator.shuttingDownCandidateIds.clear()
  coordinator.tickInFlight = false
  coordinator.now = () => Date.now()
}
