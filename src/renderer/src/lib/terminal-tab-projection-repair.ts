import type { AppState } from '@/store'
import type { TerminalTab } from '../../../shared/types'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import {
  hasTerminalTabProjectionInvariant,
  type EnsureTerminalTabProjectionSkipReason
} from '@/store/slices/terminal-tab-projection'

type ProjectionRepairState = Pick<
  AppState,
  | 'workspaceSessionReady'
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'activeGroupIdByWorktree'
  | 'layoutByWorktree'
  | 'activeTabIdByWorktree'
  | 'ensureTerminalTabProjection'
>

export type TerminalTabProjectionRepairStore = {
  getState: () => ProjectionRepairState
}

export type TerminalTabProjectionRepairSummary = {
  ready: boolean
  examinedTabCount: number
  candidateTabCount: number
  probedPtyCount: number
  livePtyCount: number
  deadPtyCount: number
  unknownPtyCount: number
  probeFailureCount: number
  timedOutPtyCount: number
  deadlineSuppressedPtyCount: number
  firstProbeError: string | null
  confirmedLiveTabCount: number
  repairedTabCount: number
  unchangedTabCount: number
  skippedTabCount: number
  projectionSkipReasons: Partial<Record<EnsureTerminalTabProjectionSkipReason, number>>
}

type RepairCandidate = {
  worktreeId: string
  tabId: string
  ptyIds: string[]
}

type ProbeOutcome =
  | { status: 'live' }
  | { status: 'dead' }
  | { status: 'unknown' }
  | { status: 'error'; error: string }
  | { status: 'timeout' }
  | { status: 'deadline' }

type RepairOptions = {
  store: TerminalTabProjectionRepairStore
  hasPty: (ptyId: string) => Promise<boolean | null>
  signal?: AbortSignal
  concurrency?: number
  probeTimeoutMs?: number
  deadlineMs?: number
}

const DEFAULT_CONCURRENCY = 8
const DEFAULT_PROBE_TIMEOUT_MS = 1_000
const DEFAULT_DEADLINE_MS = 5_000

function collectCandidatePtyIds(state: ProjectionRepairState, tab: TerminalTab): string[] {
  const ids = [
    ...(state.ptyIdsByTabId[tab.id] ?? []),
    tab.ptyId,
    ...Object.values(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {})
  ]
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
}

function collectRepairCandidates(state: ProjectionRepairState): {
  examinedTabCount: number
  candidates: RepairCandidate[]
} {
  let examinedTabCount = 0
  const candidates: RepairCandidate[] = []
  for (const worktreeId of Object.keys(state.tabsByWorktree).sort()) {
    const tabs = [...(state.tabsByWorktree[worktreeId] ?? [])].sort(
      (left, right) =>
        left.sortOrder - right.sortOrder ||
        left.createdAt - right.createdAt ||
        left.id.localeCompare(right.id)
    )
    for (const tab of tabs) {
      examinedTabCount += 1
      if (hasTerminalTabProjectionInvariant(state, worktreeId, tab.id)) {
        continue
      }
      candidates.push({
        worktreeId,
        tabId: tab.id,
        ptyIds: collectCandidatePtyIds(state, tab)
      })
    }
  }
  return { examinedTabCount, candidates }
}

function formatProbeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function probePtyWithTimeout(
  ptyId: string,
  hasPty: RepairOptions['hasPty'],
  timeoutMs: number
): Promise<ProbeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    let providerResult: Promise<boolean | null>
    try {
      providerResult = hasPty(ptyId)
    } catch (error) {
      return { status: 'error', error: formatProbeError(error) }
    }
    const providerOutcome = Promise.resolve(providerResult)
      .then<ProbeOutcome>((result) =>
        result === true
          ? { status: 'live' }
          : result === false
            ? { status: 'dead' }
            : { status: 'unknown' }
      )
      .catch<ProbeOutcome>((error) => ({ status: 'error', error: formatProbeError(error) }))
    return await Promise.race([
      providerOutcome,
      new Promise<ProbeOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

function recordProbeOutcome(
  summary: TerminalTabProjectionRepairSummary,
  outcome: ProbeOutcome
): void {
  if (outcome.status === 'live') {
    summary.livePtyCount += 1
  } else if (outcome.status === 'dead') {
    summary.deadPtyCount += 1
  } else if (outcome.status === 'unknown') {
    summary.unknownPtyCount += 1
  } else if (outcome.status === 'error') {
    summary.probeFailureCount += 1
    summary.firstProbeError ??= outcome.error
  } else if (outcome.status === 'timeout') {
    summary.timedOutPtyCount += 1
  }
}

export async function repairLiveTerminalTabProjections({
  store,
  hasPty,
  signal,
  concurrency = DEFAULT_CONCURRENCY,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  deadlineMs = DEFAULT_DEADLINE_MS
}: RepairOptions): Promise<TerminalTabProjectionRepairSummary> {
  const initial = store.getState()
  const collected = collectRepairCandidates(initial)
  const summary: TerminalTabProjectionRepairSummary = {
    ready: initial.workspaceSessionReady,
    examinedTabCount: collected.examinedTabCount,
    candidateTabCount: collected.candidates.length,
    probedPtyCount: 0,
    livePtyCount: 0,
    deadPtyCount: 0,
    unknownPtyCount: 0,
    probeFailureCount: 0,
    timedOutPtyCount: 0,
    deadlineSuppressedPtyCount: 0,
    firstProbeError: null,
    confirmedLiveTabCount: 0,
    repairedTabCount: 0,
    unchangedTabCount: 0,
    skippedTabCount: 0,
    projectionSkipReasons: {}
  }
  if (!initial.workspaceSessionReady || signal?.aborted) {
    summary.skippedTabCount = collected.candidates.length
    return summary
  }

  const deadlineAt = Date.now() + Math.max(0, deadlineMs)
  const probeCache = new Map<string, Promise<ProbeOutcome>>()
  const probe = (ptyId: string): Promise<ProbeOutcome> => {
    const existing = probeCache.get(ptyId)
    if (existing) {
      return existing
    }
    const timeoutMs = Math.min(probeTimeoutMs, Math.max(0, deadlineAt - Date.now()))
    if (timeoutMs === 0) {
      summary.deadlineSuppressedPtyCount += 1
      const deadline = Promise.resolve<ProbeOutcome>({ status: 'deadline' })
      probeCache.set(ptyId, deadline)
      return deadline
    }

    summary.probedPtyCount += 1
    const pending = probePtyWithTimeout(ptyId, hasPty, timeoutMs).then((outcome) => {
      recordProbeOutcome(summary, outcome)
      return outcome
    })
    probeCache.set(ptyId, pending)
    return pending
  }

  const probedCandidates = await mapWithConcurrency(
    collected.candidates,
    concurrency,
    async (candidate) => {
      if (signal?.aborted || candidate.ptyIds.length === 0) {
        return { candidate, livePtyIds: new Set<string>() }
      }
      const liveness = await Promise.all(
        candidate.ptyIds.map(async (ptyId) => ({ ptyId, outcome: await probe(ptyId) }))
      )
      return {
        candidate,
        livePtyIds: new Set(
          liveness.filter((item) => item.outcome.status === 'live').map((item) => item.ptyId)
        )
      }
    }
  )

  // Why: liveness probes may finish out of order, but projection insertion order is persisted UI.
  // Apply the ordered results synchronously so completion timing cannot reorder same-worktree tabs.
  for (const { candidate, livePtyIds } of probedCandidates) {
    if (livePtyIds.size === 0 || signal?.aborted) {
      summary.skippedTabCount += 1
      continue
    }

    const fresh = store.getState()
    const currentBackingTabs = (fresh.tabsByWorktree[candidate.worktreeId] ?? []).filter(
      (tab) => tab.id === candidate.tabId
    )
    if (
      currentBackingTabs.length !== 1 ||
      !collectCandidatePtyIds(fresh, currentBackingTabs[0]).some((ptyId) => livePtyIds.has(ptyId))
    ) {
      summary.skippedTabCount += 1
      continue
    }

    summary.confirmedLiveTabCount += 1
    const result = fresh.ensureTerminalTabProjection(candidate.worktreeId, candidate.tabId)
    if (result.status === 'repaired') {
      summary.repairedTabCount += 1
    } else if (result.status === 'unchanged') {
      summary.unchangedTabCount += 1
    } else {
      summary.skippedTabCount += 1
      summary.projectionSkipReasons[result.reason] =
        (summary.projectionSkipReasons[result.reason] ?? 0) + 1
    }
  }

  return summary
}
