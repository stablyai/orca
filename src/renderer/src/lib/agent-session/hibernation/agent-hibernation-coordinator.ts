import { trackAgentPaneSleep } from '@/store/terminals/agent-pane-sleep-in-flight'
import { useAppStore } from '@/store/index'
import {
  getEffectiveAgentHibernationIdleMs,
  planAgentHibernationCandidates
} from './agent-hibernation-planner'
import type { AgentHibernationCandidate } from './agent-hibernation-planner'
import { confirmAgentHibernationCandidates } from './agent-hibernation-confirmation'
import type { AgentHibernationConfirmationState } from './agent-hibernation-confirmation'
import { getAllDrivers, getDriverForPty } from '../../pane-manager/mobile-driver-state'
import {
  getForegroundTerminalTabIds,
  getForegroundTerminalTabLastSeenAtById
} from '../../../components/terminal-pane/parking/retention/foreground-terminal-tabs'
import { getAgentHibernationOutputSignature } from './agent-hibernation-output-activity'
import {
  getHibernationBoundaryResolvedAtByPaneKey,
  getHibernationPtyBindingFirstSeenAtByPaneKey,
  observeHibernationPtyBindings
} from './agent-hibernation-pane-age'
import {
  mergePendingTerminalInputActivity,
  readLastTerminalInputAt
} from '../../terminal/input/terminal-input-activity-coalescing'
import {
  collectHostPtyEvidence,
  getRuntimeLivenessTargetWorktrees,
  resolveAgentHibernationRuntimeOwner
} from './agent-hibernation-host-evidence'
import type { HostPtyEvidence } from './agent-hibernation-host-evidence'
import {
  getWindowParkVisible,
  subscribeWindowParkVisibility
} from '../../window-activity/window-park-visibility'
import type { AgentHibernationPlannerSnapshot } from './agent-hibernation-planner-snapshot'
import type { AppState } from '@/store/types'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { toRuntimePtyId } from './agent-hibernation-pane-eligibility'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { ReplacedListLookup } from './replaced-list-lookup'

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
  /** Candidates main refused while their mail waits, asked again after a doubling delay. */
  refusedCandidates: Map<string, { retryAt: number; delayMs: number }>
  now: () => number
}

const MAX_REFUSED_RETRY_MS = 16 * 60_000

// A one-pane re-check finds its tab and its bound process without re-reading a sibling's edit.
const paneTabs = new ReplacedListLookup<TerminalTab>((tab) => tab.id)
const paneBindings = new ReplacedListLookup<string>((ptyId) => ptyId)

/** Narrows a re-check to the one pane about to sleep. */
type TargetPane = { tabId: string; paneKey: string }

const coordinator: AgentHibernationCoordinatorState = {
  interval: null,
  unsubscribeVisibility: null,
  confirmationState: {},
  tickInFlight: false,
  shuttingDownCandidateIds: new Set(),
  refusedCandidates: new Map(),
  now: () => Date.now()
}

function snapshotFromState(
  state: AppState,
  now: number,
  hostEvidence: HostPtyEvidence,
  targetWorktreeId?: string,
  pane?: TargetPane
): AgentHibernationPlannerSnapshot {
  const worktreeTabs = targetWorktreeId ? (state.tabsByWorktree[targetWorktreeId] ?? []) : []
  const paneTab = pane ? paneTabs.find(worktreeTabs, pane.tabId) : undefined
  const ptyIdsByTabId = pane ? paneTabBindings(state, pane) : state.ptyIdsByTabId
  return {
    settings: state.settings,
    activeWorktreeId: state.activeWorktreeId,
    foregroundTerminalTabIds: getForegroundTerminalTabIds(),
    tabsByWorktree: targetWorktreeId
      ? {
          [targetWorktreeId]: pane ? (paneTab ? [paneTab] : []) : worktreeTabs
        }
      : state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    // A one-pane plan sees its tab's live processes as just its own, so no tab-wide set is built.
    ptyIdsByTabId,
    runtimeLivePtyIdsByWorktreeId: hostEvidence.runtimeLivePtyIdsByWorktreeId,
    // Union fresh owners with pre-await targets so newly resolved workspaces fail closed without host evidence; never narrow that set.
    runtimeLivenessRequiredWorktreeIds: [
      ...new Set([
        ...hostEvidence.runtimeLivenessRequiredWorktreeIds,
        ...getRuntimeLivenessTargetWorktrees(state, targetWorktreeId).keys()
      ])
    ],
    // A one-pane check reads only its own process's driver and its own input stamp.
    inUsePtyIds: pane
      ? panePtyIds(state, pane).filter((ptyId) => getDriverForPty(ptyId).kind === 'mobile')
      : [...getAllDrivers()]
          .filter(([, driver]) => driver.kind === 'mobile')
          .map(([ptyId]) => ptyId),
    agentStatusByPaneKey: pane
      ? new Map([[pane.paneKey, state.agentStatusByPaneKey.get(pane.paneKey)]])
      : state.agentStatusByPaneKey,
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    // Why: input stamps are coalesced, so planning must see the not-yet-flushed keystroke.
    lastTerminalInputAtByPaneKey: pane
      ? {
          [pane.paneKey]: readLastTerminalInputAt(state.lastTerminalInputAtByPaneKey, pane.paneKey)
        }
      : mergePendingTerminalInputActivity(state.lastTerminalInputAtByPaneKey),
    attentionByWorktreeId: hostEvidence.attentionByWorktreeId,
    foregroundTerminalLastSeenAtByTabId: getForegroundTerminalTabLastSeenAtById(pane?.tabId),
    ptyBindingFirstSeenAtByPaneKey: getHibernationPtyBindingFirstSeenAtByPaneKey(pane?.paneKey),
    boundaryResolvedAtByPaneKey: getHibernationBoundaryResolvedAtByPaneKey(pane?.paneKey),
    now
  }
}

const NO_BINDINGS: readonly string[] = []

/** The pane's tab bound to just the pane's own live process; a read-only plan input, not a layout write. */
function paneTabBindings(state: AppState, pane: TargetPane): Record<string, string[]> {
  const bound = state.ptyIdsByTabId[pane.tabId] ?? NO_BINDINGS
  // The planner reads bound processes under their runtime id, so one of the pane's ids is enough.
  const live = panePtyIds(state, pane).find((id) => paneBindings.find(bound, id) !== undefined)
  return Object.fromEntries([[pane.tabId, live ? [live] : []]])
}

/** The target pane's own process, under its window and runtime ids: siblings in its split are not read. */
function panePtyIds(state: AppState, pane: TargetPane): string[] {
  const leafId = parsePaneKey(pane.paneKey)?.leafId
  const ptyId = leafId ? state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[leafId] : null
  return ptyId ? [...new Set([ptyId, toRuntimePtyId(ptyId)])] : []
}

async function currentCandidates(now: number, targetWorktreeId?: string, pane?: TargetPane) {
  const hostEvidence = await collectHostPtyEvidence(
    useAppStore.getState(),
    targetWorktreeId,
    pane?.paneKey
  )
  const freshState = useAppStore.getState()
  // Sample binding ages from the plan’s state so a first-seen pane cannot already qualify as long-idle.
  // A one-pane re-check skips it: an unsampled binding fails closed, and the next tick samples it.
  if (!pane) {
    observeHibernationPtyBindings({
      tabsByWorktree: freshState.tabsByWorktree,
      terminalLayoutsByTabId: freshState.terminalLayoutsByTabId,
      now,
      idleMs: getEffectiveAgentHibernationIdleMs(freshState.settings?.agentHibernationIdleMs)
    })
  }
  return planAgentHibernationCandidates(
    snapshotFromState(freshState, now, hostEvidence, targetWorktreeId, pane)
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
  const refused = coordinator.refusedCandidates.get(id)
  if (
    coordinator.shuttingDownCandidateIds.has(id) ||
    (refused && coordinator.now() < refused.retryAt)
  ) {
    return
  }
  // Only the pane’s owner can authorize teardown; global sweeps cause C×W runtime listings for C candidates.
  const stillEligible = async () =>
    (
      await currentCandidates(coordinator.now(), worktreeId, {
        tabId: confirmedCandidate.tabId,
        paneKey: confirmedCandidate.paneKey
      })
    ).some(
      (candidate) =>
        candidate.id === confirmedCandidate.id &&
        candidate.signature === confirmedCandidate.signature
    )
  if (!(await stillEligible())) {
    return
  }
  coordinator.shuttingDownCandidateIds.add(id)
  try {
    const state = useAppStore.getState()
    const owner = resolveAgentHibernationRuntimeOwner(state, worktreeId)
    await trackAgentPaneSleep(confirmedCandidate.paneKey, () =>
      state.shutdownCompletedAgentPaneForHibernation(worktreeId, {
        paneKey: confirmedCandidate.paneKey,
        tabId: confirmedCandidate.tabId,
        leafId: confirmedCandidate.leafId,
        ptyId: confirmedCandidate.targetPtyIds[0],
        stillEligible,
        ...(owner.kind === 'runtime'
          ? { expectedRuntimePtyId: confirmedCandidate.expectedRuntimePtyIds[0] }
          : {})
      })
    )
    coordinator.refusedCandidates.delete(id)
  } catch (err) {
    // Main refuses while orchestration mail or a Dispatch is in flight; ask again later, less often.
    if (String(err).includes('orchestration_busy')) {
      const delayMs = Math.min(
        (refused?.delayMs ?? AGENT_HIBERNATION_TICK_MS) * 2,
        MAX_REFUSED_RETRY_MS
      )
      coordinator.refusedCandidates.set(id, { retryAt: coordinator.now() + delayMs, delayMs })
      return
    }
    // The user came back to the pane while main admitted the sleep: it is no longer a candidate.
    if (!String(err).includes('agent_hibernation_candidate_changed')) {
      console.warn('[agent-hibernation] failed to hibernate agent pane:', id, err)
    }
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
    const candidates = await currentCandidates(coordinator.now())
    const ids = new Set(candidates.map((candidate) => candidate.id))
    for (const id of coordinator.refusedCandidates.keys()) {
      if (!ids.has(id)) {
        coordinator.refusedCandidates.delete(id)
      }
    }
    const plan = confirmAgentHibernationCandidates(coordinator.confirmationState, candidates)
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
  coordinator.refusedCandidates.clear()
  paneTabs.clear()
  paneBindings.clear()
}
