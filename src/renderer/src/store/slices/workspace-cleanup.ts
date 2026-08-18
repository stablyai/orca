/* eslint-disable max-lines -- Why: cleanup scan persistence, renderer safety
   enrichment, dismissals, and destructive preflight/delete orchestration share
   one store state contract. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import {
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  applyWorkspaceCleanupPolicy,
  canSelectWorkspaceCleanupCandidate,
  shouldForceWorkspaceCleanupRemoval,
  shouldHideWorkspaceCleanupCandidate,
  type WorkspaceCleanupBlocker,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupDismissal,
  type WorkspaceCleanupScanArgs,
  type WorkspaceCleanupScanProgress,
  type WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import {
  getWorkspaceCleanupCandidateHostId,
  getWorkspaceCleanupCandidateIdentity,
  getWorkspaceCleanupHostIdentity
} from '../../../../shared/workspace-cleanup-host-identity'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { hydrateWorkspaceCleanupScanFromCache } from './workspace-cleanup-cache-hydration'
import {
  preflightWorkspaceCleanupCandidates,
  resolveWorkspaceCleanupRemovalTargets,
  type WorkspaceCleanupRemovalTarget
} from './workspace-cleanup-removal-targets'
import {
  getInFlightWorkspaceCleanupScan,
  hasInFlightWorkspaceCleanupScan,
  normalizeWorkspaceCleanupScanError,
  registerInFlightWorkspaceCleanupScan,
  releaseInFlightWorkspaceCleanupScan,
  supersedeInFlightWorkspaceCleanupScans,
  throwIfWorkspaceCleanupScanSuperseded
} from './workspace-cleanup-broad-scan-registry'
import { classifyTitleActivity, isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import type { PreservedBranchCleanup } from '@/lib/preserved-branch-cleanup'

export type WorkspaceCleanupFailure = {
  worktreeId: string
  /** Which host's row failed; absent only for a row with no host evidence. */
  executionHostId?: ExecutionHostId
  displayName: string
  message: string
}

export type WorkspaceCleanupRemoveResult = {
  removedIds: string[]
  /** Host-qualified keys of the rows actually removed, parallel to removedIds. */
  removedIdentities: string[]
  failures: WorkspaceCleanupFailure[]
  preservedBranches?: PreservedBranchCleanup[]
}

export type WorkspaceCleanupRemoveOptions = {
  // Why: rows are removed long after the confirm click; the confirm-time
  // candidate records how much git risk the user actually approved.
  approvedCandidates?: readonly WorkspaceCleanupCandidate[]
  snapshotPruneBatchId?: string
}

type WorkspaceCleanupViewedCandidate = {
  viewedAt: number
  fingerprint: string
  wasSuggested: boolean
}

export type WorkspaceCleanupSlice = {
  workspaceCleanupScan: WorkspaceCleanupScanResult | null
  workspaceCleanupProgress: WorkspaceCleanupScanProgress | null
  workspaceCleanupLoading: boolean
  workspaceCleanupError: string | null
  workspaceCleanupDismissals: Record<string, WorkspaceCleanupDismissal>
  workspaceCleanupViewedCandidates: Record<string, WorkspaceCleanupViewedCandidate>
  scanWorkspaceCleanup: (args?: WorkspaceCleanupScanArgs) => Promise<WorkspaceCleanupScanResult>
  /** Stale-while-revalidate seed; true when the persisted snapshot filled an empty slice. */
  hydrateWorkspaceCleanupFromCache: () => Promise<boolean>
  markWorkspaceCleanupCandidateViewed: (candidate: WorkspaceCleanupCandidate) => void
  dismissWorkspaceCleanupCandidates: (
    candidates: readonly WorkspaceCleanupCandidate[]
  ) => Promise<void>
  resetWorkspaceCleanupDismissals: () => Promise<void>
  removeWorkspaceCleanupCandidates: (
    worktreeIds: readonly string[],
    options?: WorkspaceCleanupRemoveOptions
  ) => Promise<WorkspaceCleanupRemoveResult>
}

type EnrichOptions = {
  applyDismissals?: boolean
}

type WorkspaceCleanupEnrichmentCacheEntry = {
  /** Fast path: same candidate object + unchanged local-state token = hit without stringify. */
  candidateRef: WorkspaceCleanupCandidate
  inputSignature: string
  localSignature: string
  candidate: WorkspaceCleanupCandidate
}

type WorkspaceCleanupEnrichmentProjection = {
  openFilesByWorktreeId: Map<string, AppState['openFiles']>
  retainedDoneAgentPaneKeysByWorktreeId: Map<string, string[]>
  agentStatusesByTabId: Map<string, AgentStatusEntry[]>
}

const RECENT_VISIBLE_CONTEXT_MS = 24 * 60 * 60 * 1000
const VIEWED_FROM_CLEANUP_MS = 2 * 60 * 60 * 1000
export const WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY = 8
let latestWorkspaceCleanupScanToken = 0
let finalizedWorkspaceCleanupScanToken = 0
let workspaceCleanupProgressQueue: {
  scanToken: number
  promise: Promise<void>
} | null = null
let workspaceCleanupEnrichmentCache: {
  scanToken: number
  localToken: readonly unknown[] | null
  entries: Map<string, WorkspaceCleanupEnrichmentCacheEntry>
} | null = null
// Why: cleanup progress can append thousands of rows; keep one scan-local
// index so each streamed row does not rebuild a map of every previous row.
let workspaceCleanupProgressCandidateIndex: {
  scanToken: number
  scanId: string
  candidates: WorkspaceCleanupCandidate[]
  indexesByIdentity: Map<string, number>
} | null = null

const SHELL_PROCESS_NAMES = new Set([
  'bash',
  'cmd',
  'fish',
  'nu',
  'powershell',
  'pwsh',
  'sh',
  'zsh'
])

const AGENT_PROCESS_NAMES = new Set([
  'aider',
  'amp',
  'agy',
  'claude',
  'claude-code',
  'codex',
  'crush',
  'droid',
  'gemini',
  'gemini-cli',
  'goose',
  'opencode'
])

export const createWorkspaceCleanupSlice: StateCreator<AppState, [], [], WorkspaceCleanupSlice> = (
  set,
  get
) => ({
  workspaceCleanupScan: null,
  workspaceCleanupProgress: null,
  workspaceCleanupLoading: false,
  workspaceCleanupError: null,
  workspaceCleanupDismissals: {},
  workspaceCleanupViewedCandidates: {},

  scanWorkspaceCleanup: async (args) => {
    if (args?.worktreeId !== undefined || args?.worktreeIds !== undefined) {
      const scan = await window.api.workspaceCleanup.scan(args)
      const enriched = await enrichWorkspaceCleanupCandidates(scan.candidates, get(), {
        applyDismissals: false
      })
      return { ...scan, candidates: enriched }
    }

    const scanArgs = {
      // Why: the dialog renders one flat list of every workspace, so a broad
      // scan must not stop at the 30-day-idle suggestions.
      includeAllWorkspaces: true,
      ...args,
      skipGitWorktreeIds: [
        ...new Set([
          ...(args?.skipGitWorktreeIds ?? []),
          ...getInitialWorkspaceCleanupGitDeferrals(get())
        ])
      ],
      // Broad scan identity belongs to this store request; caller-provided IDs
      // are reserved for focused scans and can collide across refresh variants.
      scanId: crypto.randomUUID()
    }
    const scanKey = getWorkspaceCleanupScanKey(scanArgs)

    const existingInFlight = getInFlightWorkspaceCleanupScan(scanKey)
    if (existingInFlight) {
      set({ workspaceCleanupLoading: true, workspaceCleanupError: null })
      try {
        return await existingInFlight
      } finally {
        if (!hasInFlightWorkspaceCleanupScan(scanKey)) {
          set({ workspaceCleanupLoading: false })
        }
      }
    }

    // Why: a different scan key (git deferrals track live tab/agent state) must
    // not leave the previous fleet scan running concurrently in main — cancel
    // and supersede it instead of racing it. Legacy suggestion-only and
    // full-workspace scans are separate modes and never supersede each other.
    supersedeInFlightWorkspaceCleanupScans(
      window.api.workspaceCleanup.cancelScan,
      (key) => getWorkspaceCleanupScanKeyMode(key) === (scanArgs.includeAllWorkspaces === true)
    )
    set({
      workspaceCleanupLoading: true,
      workspaceCleanupProgress: null,
      workspaceCleanupError: null
    })
    const scanToken = ++latestWorkspaceCleanupScanToken
    finalizedWorkspaceCleanupScanToken = 0
    workspaceCleanupProgressQueue = null
    workspaceCleanupEnrichmentCache = { scanToken, localToken: null, entries: new Map() }
    workspaceCleanupProgressCandidateIndex = null
    const promise = (async () => {
      try {
        const scan = await window.api.workspaceCleanup.scan(scanArgs, (progress) => {
          enqueueWorkspaceCleanupProgress(progress, scanToken, get, set)
        })
        throwIfWorkspaceCleanupScanSuperseded(scanArgs.scanId)
        await drainWorkspaceCleanupProgressQueue(scanToken)
        const enriched = await enrichWorkspaceCleanupCandidatesForScan(
          scan.candidates,
          get(),
          scanToken
        )
        throwIfWorkspaceCleanupScanSuperseded(scanArgs.scanId)
        const result = { ...scan, candidates: enriched }
        if (scanToken === latestWorkspaceCleanupScanToken) {
          finalizedWorkspaceCleanupScanToken = scanToken
          workspaceCleanupEnrichmentCache = null
          workspaceCleanupProgressCandidateIndex = null
          set({
            workspaceCleanupScan: result,
            workspaceCleanupProgress: {
              scanId: get().workspaceCleanupProgress?.scanId ?? scanArgs.scanId,
              scannedAt: result.scannedAt,
              scannedWorktreeCount: result.candidates.length,
              totalWorktreeCount: result.candidates.length,
              candidates: result.candidates,
              errors: result.errors
            },
            workspaceCleanupLoading: false
          })
        }
        return result
      } catch (error) {
        throw normalizeWorkspaceCleanupScanError(scanArgs.scanId, error)
      }
    })()
    registerInFlightWorkspaceCleanupScan(scanKey, scanArgs.scanId, promise)

    try {
      return await promise
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (scanToken === latestWorkspaceCleanupScanToken) {
        set({ workspaceCleanupError: message, workspaceCleanupLoading: false })
      }
      throw error
    } finally {
      releaseInFlightWorkspaceCleanupScan(scanKey, scanArgs.scanId, promise)
    }
  },

  hydrateWorkspaceCleanupFromCache: () =>
    hydrateWorkspaceCleanupScanFromCache({
      // Why: loading covers an in-flight broad scan whose progress may not have
      // reached the store yet; the cache must never clobber either.
      hasLiveScanState: () => get().workspaceCleanupScan !== null || get().workspaceCleanupLoading,
      enrich: (candidates) => enrichWorkspaceCleanupCandidates(candidates, get()),
      apply: (scan) => set({ workspaceCleanupScan: scan })
    }),

  markWorkspaceCleanupCandidateViewed: (candidate) => {
    const now = Date.now()
    set((state) => ({
      workspaceCleanupViewedCandidates: {
        // Why: entries expire for policy after VIEWED_FROM_CLEANUP_MS anyway;
        // pruning them on write keeps this record from growing for the
        // lifetime of the process.
        ...Object.fromEntries(
          Object.entries(state.workspaceCleanupViewedCandidates).filter(
            ([, viewed]) => now - viewed.viewedAt <= VIEWED_FROM_CLEANUP_MS
          )
        ),
        [candidate.worktreeId]: {
          viewedAt: now,
          fingerprint: candidate.fingerprint,
          wasSuggested: candidate.tier === 'ready' && canSelectWorkspaceCleanupCandidate(candidate)
        }
      }
    }))
  },

  dismissWorkspaceCleanupCandidates: async (candidates) => {
    const now = Date.now()
    const dismissals = candidates.map((candidate) => ({
      worktreeId: candidate.worktreeId,
      // Why (STA-4343): ignoring one host's row must not hide the same-id row
      // on another host; the stored host scopes the match.
      executionHostId: getWorkspaceCleanupCandidateHostId(candidate),
      dismissedAt: now,
      fingerprint: candidate.fingerprint,
      classifierVersion: WORKSPACE_CLEANUP_CLASSIFIER_VERSION
    }))

    set((state) => {
      const nextDismissals = { ...state.workspaceCleanupDismissals }
      for (const dismissal of dismissals) {
        nextDismissals[
          getWorkspaceCleanupCandidateIdentity({
            worktreeId: dismissal.worktreeId,
            executionHostId: dismissal.executionHostId
          })
        ] = dismissal
      }
      const nextScan = state.workspaceCleanupScan
        ? {
            ...state.workspaceCleanupScan,
            candidates: state.workspaceCleanupScan.candidates.map((candidate) =>
              applyDismissal(candidate, nextDismissals)
            )
          }
        : state.workspaceCleanupScan
      return {
        workspaceCleanupDismissals: nextDismissals,
        workspaceCleanupScan: nextScan
      }
    })

    await window.api.workspaceCleanup.dismiss({ dismissals })
  },

  resetWorkspaceCleanupDismissals: async () => {
    set((state) => ({
      workspaceCleanupDismissals: {},
      workspaceCleanupScan: state.workspaceCleanupScan
        ? {
            ...state.workspaceCleanupScan,
            candidates: state.workspaceCleanupScan.candidates.map((candidate) =>
              applyWorkspaceCleanupPolicy({
                ...candidate,
                blockers: candidate.blockers.filter((blocker) => blocker !== 'dismissed')
              })
            )
          }
        : state.workspaceCleanupScan
    }))
    await window.api.workspaceCleanup.clearDismissals()
  },

  removeWorkspaceCleanupCandidates: async (worktreeIds, options) => {
    const removedIds: string[] = []
    const removedIdentities = new Set<string>()
    const failures: WorkspaceCleanupFailure[] = []
    const preservedBranches: PreservedBranchCleanup[] = []

    // Why (STA-4343): the confirmed row — not the id — names the host to delete
    // on. Everything below carries that owner so nothing re-derives it from the
    // active workspace, which owns the same `repoId::path` id on another host.
    const targets = resolveWorkspaceCleanupRemovalTargets(
      worktreeIds,
      get(),
      options?.approvedCandidates ? { approvedCandidates: options.approvedCandidates } : {}
    )
    const removableTargets: WorkspaceCleanupRemovalTarget[] = []
    for (const target of targets) {
      if (target.kind === 'unresolved') {
        failures.push(target.failure)
        continue
      }
      removableTargets.push(target)
    }

    const preflights = await preflightWorkspaceCleanupCandidates(
      removableTargets,
      get,
      (candidates, state) =>
        enrichWorkspaceCleanupCandidates(candidates, state, { applyDismissals: false })
    )
    const targetsToRemove: {
      target: WorkspaceCleanupRemovalTarget
      candidate: WorkspaceCleanupCandidate
      sameIdSurvivingHostId?: ExecutionHostId
      ignoreWorkspaceCleanupScanSurvivors?: boolean
    }[] = []

    for (const preflight of preflights) {
      if (!preflight.ok) {
        failures.push(preflight.failure)
        continue
      }
      targetsToRemove.push({
        target: preflight.target,
        candidate: preflight.candidate,
        ...(preflight.sameIdSurvivingHostId
          ? { sameIdSurvivingHostId: preflight.sameIdSurvivingHostId }
          : {})
      })
    }
    const scheduledRemovalIdentities = new Set(
      targetsToRemove.map(({ candidate }) => getWorkspaceCleanupCandidateIdentity(candidate))
    )
    for (const pendingRemoval of targetsToRemove) {
      if (
        pendingRemoval.sameIdSurvivingHostId &&
        scheduledRemovalIdentities.has(
          getWorkspaceCleanupHostIdentity(
            pendingRemoval.sameIdSurvivingHostId,
            pendingRemoval.candidate.worktreeId
          )
        )
      ) {
        delete pendingRemoval.sameIdSurvivingHostId
        pendingRemoval.ignoreWorkspaceCleanupScanSurvivors = true
      }
    }

    // Why: nested workspaces can belong to different repos; parent removal must
    // not race child cleanup hooks, PTY teardown, or metadata deletion.
    for (const {
      target,
      candidate,
      sameIdSurvivingHostId,
      ignoreWorkspaceCleanupScanSurvivors
    } of [...targetsToRemove].sort((a, b) => b.candidate.path.length - a.candidate.path.length)) {
      const result = await get().removeWorktree(
        // The resolved target names the host whose row the user confirmed; the
        // removal is routed there instead of to the active workspace's host.
        { id: candidate.worktreeId, executionHostId: target.executionHostId },
        shouldForceWorkspaceCleanupRemoval(candidate),
        // Why: cleanup reports outcomes in its own summary toasts; per-row
        // preserved-branch warnings would stack one toast per removed row.
        {
          suppressPreservedBranchToast: true,
          ...(sameIdSurvivingHostId ? { sameIdSurvivingHostId } : {}),
          ...(ignoreWorkspaceCleanupScanSurvivors
            ? { ignoreWorkspaceCleanupScanSurvivors: true }
            : {}),
          ...(options?.snapshotPruneBatchId
            ? { snapshotPruneBatchId: options.snapshotPruneBatchId }
            : {})
        }
      )
      if (result.ok) {
        removedIds.push(candidate.worktreeId)
        removedIdentities.add(getWorkspaceCleanupCandidateIdentity(candidate))
        if (result.preservedBranch) {
          preservedBranches.push({
            worktreeId: candidate.worktreeId,
            branchName: result.preservedBranch.branchName,
            expectedHead: result.preservedBranch.head,
            ...(result.preservedBranch.hostId ? { hostId: result.preservedBranch.hostId } : {}),
            ...(result.preservedBranch.runtimeEnvironmentId
              ? { runtimeEnvironmentId: result.preservedBranch.runtimeEnvironmentId }
              : {})
          })
        }
      } else {
        failures.push({
          worktreeId: candidate.worktreeId,
          ...(target.executionHostId ? { executionHostId: target.executionHostId } : {}),
          displayName: candidate.displayName,
          message: result.error
        })
      }
    }

    if (removedIds.length > 0) {
      invalidateWorkspaceCleanupScanProgress()
      let prunableWorktreeIds = new Set(removedIds)
      set((state) => {
        const remainingCandidates = state.workspaceCleanupScan?.candidates.filter(
          (candidate) => !removedIdentities.has(getWorkspaceCleanupCandidateIdentity(candidate))
        )
        // Why: a same-id row on another host survives this removal, and its
        // dismissal/viewed marks are keyed by worktree id alone — dropping them
        // would resurrect a row the user already ignored.
        const survivingWorktreeIds = new Set(
          (remainingCandidates ?? []).map((candidate) => candidate.worktreeId)
        )
        prunableWorktreeIds = new Set(
          removedIds.filter((worktreeId) => !survivingWorktreeIds.has(worktreeId))
        )
        return {
          workspaceCleanupLoading: false,
          workspaceCleanupScan:
            state.workspaceCleanupScan && remainingCandidates
              ? { ...state.workspaceCleanupScan, candidates: remainingCandidates }
              : state.workspaceCleanupScan,
          // Why: dismissals and viewed marks for removed worktrees are dead
          // weight in the store and in every persisted-dismissals write.
          workspaceCleanupDismissals: pruneWorkspaceCleanupDismissals(
            state.workspaceCleanupDismissals,
            prunableWorktreeIds
          ),
          workspaceCleanupViewedCandidates: pruneWorkspaceCleanupRecord(
            state.workspaceCleanupViewedCandidates,
            prunableWorktreeIds
          )
        }
      })
      if (prunableWorktreeIds.size > 0) {
        void window.api.workspaceCleanup
          .dismiss({ dismissals: [], removedWorktreeIds: [...prunableWorktreeIds] })
          .catch((error: unknown) => {
            console.warn('Failed to prune persisted cleanup dismissals', error)
          })
      }
    }

    return {
      removedIds,
      removedIdentities: [...removedIdentities],
      failures,
      ...(preservedBranches.length > 0 ? { preservedBranches } : {})
    }
  }
})

function getWorkspaceCleanupScanKey(args: WorkspaceCleanupScanArgs): string {
  return JSON.stringify({
    includeAllWorkspaces: args.includeAllWorkspaces === true,
    skipGitWorktreeIds: [...new Set(args.skipGitWorktreeIds ?? [])].sort()
  })
}

function getWorkspaceCleanupScanKeyMode(key: string): boolean {
  try {
    return (JSON.parse(key) as { includeAllWorkspaces?: boolean }).includeAllWorkspaces === true
  } catch {
    return false
  }
}

function invalidateWorkspaceCleanupScanProgress(): void {
  latestWorkspaceCleanupScanToken += 1
  finalizedWorkspaceCleanupScanToken = 0
  supersedeInFlightWorkspaceCleanupScans(window.api.workspaceCleanup.cancelScan)
  workspaceCleanupProgressQueue = null
  workspaceCleanupEnrichmentCache = null
  workspaceCleanupProgressCandidateIndex = null
}

function enqueueWorkspaceCleanupProgress(
  progress: WorkspaceCleanupScanProgress,
  scanToken: number,
  getState: () => AppState,
  setState: (
    partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
    replace?: false
  ) => void
): void {
  if (
    scanToken !== latestWorkspaceCleanupScanToken ||
    scanToken === finalizedWorkspaceCleanupScanToken
  ) {
    return
  }
  const previous =
    workspaceCleanupProgressQueue?.scanToken === scanToken
      ? workspaceCleanupProgressQueue.promise
      : Promise.resolve()
  const promise = previous
    .catch(() => undefined)
    .then(() => applyWorkspaceCleanupProgress(progress, scanToken, getState, setState))
    .catch((error: unknown) => {
      console.error('Workspace cleanup progress update failed', error)
    })
  workspaceCleanupProgressQueue = { scanToken, promise }
}

// Why: IPC final follows progress immediately; drain it to share cache and concurrency cap.
async function drainWorkspaceCleanupProgressQueue(scanToken: number): Promise<void> {
  while (workspaceCleanupProgressQueue?.scanToken === scanToken) {
    const queuedProgress = workspaceCleanupProgressQueue.promise
    await queuedProgress
    if (workspaceCleanupProgressQueue?.promise === queuedProgress) {
      return
    }
  }
}

async function applyWorkspaceCleanupProgress(
  progress: WorkspaceCleanupScanProgress,
  scanToken: number,
  getState: () => AppState,
  setState: (
    partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
    replace?: false
  ) => void
): Promise<void> {
  if (
    scanToken !== latestWorkspaceCleanupScanToken ||
    scanToken === finalizedWorkspaceCleanupScanToken
  ) {
    return
  }
  const state = getState()
  // Why: a cached snapshot (or the previous settled scan) may already fill the
  // list; streamed rows reconcile into it by worktreeId so a refresh never
  // clears and rebuilds what the user is reading.
  const previousCandidates =
    state.workspaceCleanupProgress?.scanId === progress.scanId
      ? state.workspaceCleanupProgress.candidates
      : (state.workspaceCleanupScan?.candidates ?? [])
  const enrichedProgressCandidates = await enrichWorkspaceCleanupCandidatesForScan(
    progress.candidates,
    state,
    scanToken
  )
  if (
    scanToken !== latestWorkspaceCleanupScanToken ||
    scanToken === finalizedWorkspaceCleanupScanToken
  ) {
    return
  }
  const candidates = mergeWorkspaceCleanupProgressCandidates({
    previousCandidates,
    nextCandidates: enrichedProgressCandidates,
    progress,
    scanToken
  })
  if (
    scanToken !== latestWorkspaceCleanupScanToken ||
    scanToken === finalizedWorkspaceCleanupScanToken
  ) {
    workspaceCleanupProgressCandidateIndex = null
    return
  }
  const dismissalsAtEnrichment = state.workspaceCleanupDismissals
  setState((state) => {
    if (
      state.workspaceCleanupProgress?.scanId === progress.scanId &&
      state.workspaceCleanupProgress.scannedWorktreeCount > progress.scannedWorktreeCount
    ) {
      // Why: `return state` is Zustand's real no-op; a fresh `{}` would still
      // sweep every subscriber.
      return state
    }
    // Why: a dismissal committed while this frame's enrichment awaited must
    // not be clobbered by candidates derived from the pre-await snapshot.
    const finalCandidates =
      state.workspaceCleanupDismissals === dismissalsAtEnrichment
        ? candidates
        : candidates.map((candidate) => applyDismissal(candidate, state.workspaceCleanupDismissals))
    return {
      workspaceCleanupScan: {
        // Why: mid-refresh the list still mixes in rows from the previous
        // snapshot; the honest "as of" time stays the snapshot's until the new
        // scan settles and removes vanished rows.
        scannedAt: state.workspaceCleanupScan?.scannedAt ?? progress.scannedAt,
        candidates: finalCandidates,
        errors: progress.errors
      },
      workspaceCleanupProgress: { ...progress, candidates: finalCandidates }
    }
  })
}

async function enrichWorkspaceCleanupCandidatesForScan(
  candidates: readonly WorkspaceCleanupCandidate[],
  state: AppState,
  scanToken: number
): Promise<WorkspaceCleanupCandidate[]> {
  if (workspaceCleanupEnrichmentCache?.scanToken !== scanToken) {
    workspaceCleanupEnrichmentCache = { scanToken, localToken: null, entries: new Map() }
  }
  const cache = workspaceCleanupEnrichmentCache
  const localToken = buildWorkspaceCleanupLocalStateToken(state)
  const localStateUnchanged =
    cache.localToken !== null &&
    cache.localToken.length === localToken.length &&
    cache.localToken.every((value, index) => value === localToken[index])
  cache.localToken = localToken
  return enrichWorkspaceCleanupCandidatesWithCache(candidates, state, cache.entries, {
    localStateUnchanged
  })
}

/**
 * Identity token over every state slice the local signature projects — a
 * strict superset of getWorkspaceCleanupLocalStateSignature's inputs, so an
 * unchanged token guarantees an unchanged signature without stringifying.
 */
function buildWorkspaceCleanupLocalStateToken(state: AppState): readonly unknown[] {
  return [
    state.activeWorktreeId,
    state.tabsByWorktree,
    state.ptyIdsByTabId,
    state.runtimePaneTitlesByTabId,
    state.terminalLayoutsByTabId,
    state.openFiles,
    state.editorDrafts,
    state.browserTabsByWorktree,
    state.retainedAgentsByPaneKey,
    state.agentStatusByPaneKey,
    state.lastVisitedAtByWorktreeId,
    state.workspaceCleanupViewedCandidates,
    state.workspaceCleanupDismissals
  ]
}

function mergeWorkspaceCleanupProgressCandidates({
  previousCandidates,
  nextCandidates,
  progress,
  scanToken
}: {
  previousCandidates: readonly WorkspaceCleanupCandidate[]
  nextCandidates: readonly WorkspaceCleanupCandidate[]
  progress: WorkspaceCleanupScanProgress
  scanToken: number
}): WorkspaceCleanupCandidate[] {
  // Why: snapshot-mode ticks also merge — replacing would drop the
  // stale-while-revalidate rows this scan has not re-reported yet.
  if (nextCandidates.length === 0) {
    return previousCandidates as WorkspaceCleanupCandidate[]
  }

  const indexCache = getWorkspaceCleanupProgressCandidateIndex(
    previousCandidates,
    progress.scanId,
    scanToken
  )
  const merged = [...indexCache.candidates]
  for (const candidate of nextCandidates) {
    // Why (STA-4343): two hosts publish the same `repoId::path` id; keying the
    // merge on the id alone made one host's row overwrite the other's.
    const identity = getWorkspaceCleanupCandidateIdentity(candidate)
    const existingIndex = indexCache.indexesByIdentity.get(identity)
    if (existingIndex === undefined) {
      indexCache.indexesByIdentity.set(identity, merged.length)
      merged.push(candidate)
      continue
    }
    merged[existingIndex] = candidate
  }
  workspaceCleanupProgressCandidateIndex = {
    scanToken,
    scanId: progress.scanId,
    candidates: merged,
    indexesByIdentity: indexCache.indexesByIdentity
  }
  return merged
}

function getWorkspaceCleanupProgressCandidateIndex(
  candidates: readonly WorkspaceCleanupCandidate[],
  scanId: string,
  scanToken: number
): {
  candidates: WorkspaceCleanupCandidate[]
  indexesByIdentity: Map<string, number>
} {
  if (
    workspaceCleanupProgressCandidateIndex?.scanToken === scanToken &&
    workspaceCleanupProgressCandidateIndex.scanId === scanId &&
    workspaceCleanupProgressCandidateIndex.candidates === candidates
  ) {
    return workspaceCleanupProgressCandidateIndex
  }

  return {
    candidates: [...candidates],
    indexesByIdentity: new Map(
      candidates.map((candidate, index) => [getWorkspaceCleanupCandidateIdentity(candidate), index])
    )
  }
}

function getInitialWorkspaceCleanupGitDeferrals(state: AppState): string[] {
  const ids = new Set<string>()
  if (state.activeWorktreeId) {
    ids.add(state.activeWorktreeId)
  }

  for (const file of state.openFiles) {
    if (file.isDirty || state.editorDrafts[file.id] !== undefined) {
      ids.add(file.worktreeId)
    }
  }

  const openEditorWorktreeIds = new Set(state.openFiles.map((file) => file.worktreeId))
  const agentStatusesByTabId = buildWorkspaceCleanupAgentStatusIndex(state)
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const tabIds = new Set(tabs.map((tab) => tab.id))
    if (tabs.some((tab) => (state.ptyIdsByTabId[tab.id]?.length ?? 0) > 0)) {
      ids.add(worktreeId)
    }
    if (
      hasFreshIndexedLiveAgent(agentStatusesByTabId, tabIds) ||
      hasWorkingTitleAgent(state, tabs)
    ) {
      ids.add(worktreeId)
    }
  }

  for (const worktreeId of new Set([
    ...openEditorWorktreeIds,
    ...Object.keys(state.browserTabsByWorktree)
  ])) {
    const hasVisibleContext =
      openEditorWorktreeIds.has(worktreeId) ||
      (state.browserTabsByWorktree[worktreeId]?.length ?? 0) > 0
    const lastVisitedAt = state.lastVisitedAtByWorktreeId[worktreeId] ?? 0
    if (
      hasVisibleContext &&
      lastVisitedAt > 0 &&
      Date.now() - lastVisitedAt <= RECENT_VISIBLE_CONTEXT_MS
    ) {
      ids.add(worktreeId)
    }
  }

  // Why: these rows must stay visible, but they already need user attention.
  // Defer expensive git reads until a focused refresh/remove preflight.
  return [...ids]
}

export async function enrichWorkspaceCleanupCandidates(
  candidates: readonly WorkspaceCleanupCandidate[],
  state: AppState,
  options: EnrichOptions = {}
): Promise<WorkspaceCleanupCandidate[]> {
  const projection = buildWorkspaceCleanupEnrichmentProjection(candidates, state)
  return mapWithConcurrency(candidates, WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY, (candidate) =>
    enrichWorkspaceCleanupCandidate(candidate, state, projection, options)
  )
}

async function enrichWorkspaceCleanupCandidatesWithCache(
  candidates: readonly WorkspaceCleanupCandidate[],
  state: AppState,
  cache: Map<string, WorkspaceCleanupEnrichmentCacheEntry>,
  options: EnrichOptions & { localStateUnchanged?: boolean } = {}
): Promise<WorkspaceCleanupCandidate[]> {
  const projection = buildWorkspaceCleanupEnrichmentProjection(candidates, state)
  return mapWithConcurrency(
    candidates,
    WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY,
    async (candidate) => {
      const identity = getWorkspaceCleanupCandidateIdentity(candidate)
      const cached = cache.get(identity)
      if (options.localStateUnchanged === true && cached?.candidateRef === candidate) {
        return cached.candidate
      }
      const inputSignature = getWorkspaceCleanupCandidateInputSignature(candidate)
      const localSignature = getWorkspaceCleanupLocalStateSignature(
        candidate,
        state,
        projection,
        options
      )
      if (cached?.inputSignature === inputSignature && cached.localSignature === localSignature) {
        cached.candidateRef = candidate
        return cached.candidate
      }

      const enriched = await enrichWorkspaceCleanupCandidate(candidate, state, projection, options)
      cache.set(identity, {
        candidateRef: candidate,
        inputSignature,
        localSignature,
        candidate: enriched
      })
      return enriched
    }
  )
}

function buildWorkspaceCleanupEnrichmentProjection(
  candidates: readonly WorkspaceCleanupCandidate[],
  state: AppState
): WorkspaceCleanupEnrichmentProjection {
  const worktreeIds = new Set(candidates.map((candidate) => candidate.worktreeId))
  const tabIds = new Set<string>()
  for (const worktreeId of worktreeIds) {
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      tabIds.add(tab.id)
    }
  }

  const openFilesByWorktreeId = new Map<string, AppState['openFiles']>()
  for (const file of state.openFiles) {
    if (!worktreeIds.has(file.worktreeId)) {
      continue
    }
    const files = openFilesByWorktreeId.get(file.worktreeId) ?? []
    files.push(file)
    openFilesByWorktreeId.set(file.worktreeId, files)
  }

  const retainedDoneAgentPaneKeysByWorktreeId = new Map<string, string[]>()
  for (const [paneKey, retained] of Object.entries(state.retainedAgentsByPaneKey)) {
    if (!worktreeIds.has(retained.worktreeId) || retained.entry.state !== 'done') {
      continue
    }
    const paneKeys = retainedDoneAgentPaneKeysByWorktreeId.get(retained.worktreeId) ?? []
    paneKeys.push(paneKey)
    retainedDoneAgentPaneKeysByWorktreeId.set(retained.worktreeId, paneKeys)
  }

  const agentStatusesByTabId = buildWorkspaceCleanupAgentStatusIndex(state, tabIds)

  return {
    openFilesByWorktreeId,
    retainedDoneAgentPaneKeysByWorktreeId,
    agentStatusesByTabId
  }
}

function getWorkspaceCleanupCandidateInputSignature(candidate: WorkspaceCleanupCandidate): string {
  return JSON.stringify({
    fingerprint: candidate.fingerprint,
    blockers: candidate.blockers,
    reasons: candidate.reasons,
    git: candidate.git,
    lastActivityAt: candidate.lastActivityAt,
    createdAt: candidate.createdAt,
    path: candidate.path,
    branch: candidate.branch
  })
}

function getWorkspaceCleanupLocalStateSignature(
  candidate: WorkspaceCleanupCandidate,
  state: AppState,
  projection: WorkspaceCleanupEnrichmentProjection,
  options: EnrichOptions
): string {
  const { worktreeId } = candidate
  const tabs = state.tabsByWorktree[worktreeId] ?? []
  const tabIds = tabs.map((tab) => tab.id)
  const tabIdSet = new Set(tabIds)
  const openFiles = (projection.openFilesByWorktreeId.get(worktreeId) ?? []).map((file) => ({
    id: file.id,
    isDirty: file.isDirty,
    hasDraft: state.editorDrafts[file.id] !== undefined
  }))
  const retainedDoneAgentPaneKeys = [
    ...(projection.retainedDoneAgentPaneKeysByWorktreeId.get(worktreeId) ?? [])
  ].sort()
  const agentStatuses = [...tabIdSet]
    .flatMap((tabId) => projection.agentStatusesByTabId.get(tabId) ?? [])
    .map((entry) => ({
      paneKey: entry.paneKey,
      state: entry.state,
      updatedAt: entry.updatedAt
    }))
    .sort((a, b) => a.paneKey.localeCompare(b.paneKey))
  const ptyIdsByTabId = Object.fromEntries(
    tabIds.map((tabId) => [tabId, state.ptyIdsByTabId[tabId] ?? []])
  )
  const runtimePaneTitlesByTabId = Object.fromEntries(
    tabIds.map((tabId) => [tabId, state.runtimePaneTitlesByTabId[tabId] ?? {}])
  )
  const terminalLayoutsByTabId = Object.fromEntries(
    tabIds.map((tabId) => [tabId, state.terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId ?? {}])
  )
  const dismissal =
    options.applyDismissals === false
      ? null
      : (getWorkspaceCleanupDismissal(candidate, state.workspaceCleanupDismissals) ?? null)

  return JSON.stringify({
    active: state.activeWorktreeId === worktreeId,
    tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title })),
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    terminalLayoutsByTabId,
    openFiles,
    browserTabCount: (state.browserTabsByWorktree[worktreeId] ?? []).length,
    retainedDoneAgentPaneKeys,
    agentStatuses,
    lastVisitedAt: state.lastVisitedAtByWorktreeId[worktreeId] ?? 0,
    viewed: state.workspaceCleanupViewedCandidates[worktreeId] ?? null,
    dismissal
  })
}

async function enrichWorkspaceCleanupCandidate(
  candidate: WorkspaceCleanupCandidate,
  state: AppState,
  projection: WorkspaceCleanupEnrichmentProjection,
  options: EnrichOptions
): Promise<WorkspaceCleanupCandidate> {
  const tabs = state.tabsByWorktree[candidate.worktreeId] ?? []
  const tabIds = new Set(tabs.map((tab) => tab.id))
  const openFiles = projection.openFilesByWorktreeId.get(candidate.worktreeId) ?? []
  const dirtyEditorBuffers = openFiles.filter(
    (file) => file.isDirty || state.editorDrafts[file.id] !== undefined
  )
  const cleanEditorTabCount = openFiles.length - dirtyEditorBuffers.length
  const browserTabCount = (state.browserTabsByWorktree[candidate.worktreeId] ?? []).length
  const retainedDoneAgentCount =
    projection.retainedDoneAgentPaneKeysByWorktreeId.get(candidate.worktreeId)?.length ?? 0
  const blockers = candidate.blockers.filter((blocker) => blocker !== 'dismissed')
  const preserveCleanupInspection = shouldPreserveCleanupInspection(candidate, state)

  if (state.activeWorktreeId === candidate.worktreeId) {
    blockers.push('active-workspace')
  }
  if (dirtyEditorBuffers.length > 0) {
    blockers.push('dirty-editor-buffer')
  }
  if (hasFreshIndexedLiveAgent(projection.agentStatusesByTabId, tabIds)) {
    blockers.push('live-agent')
  }
  if (hasWorkingTitleAgent(state, tabs)) {
    blockers.push('live-agent')
  }

  const terminalProbe = await probeTerminalLiveness(state, tabs)
  if (terminalProbe === 'running') {
    blockers.push('running-terminal')
  } else if (terminalProbe === 'unknown') {
    blockers.push('terminal-liveness-unknown')
  }

  const lastVisitedAt = state.lastVisitedAtByWorktreeId[candidate.worktreeId] ?? 0
  const hasVisibleContext = cleanEditorTabCount > 0 || browserTabCount > 0
  if (
    hasVisibleContext &&
    !preserveCleanupInspection &&
    lastVisitedAt > 0 &&
    Date.now() - lastVisitedAt <= RECENT_VISIBLE_CONTEXT_MS
  ) {
    blockers.push('recent-visible-context')
  }

  const enriched = applyWorkspaceCleanupPolicy({
    ...candidate,
    blockers: [...new Set(blockers)],
    localContext: {
      ...candidate.localContext,
      terminalTabCount: tabs.length,
      cleanEditorTabCount,
      browserTabCount,
      retainedDoneAgentCount
    }
  })

  return options.applyDismissals === false
    ? enriched
    : applyDismissal(enriched, state.workspaceCleanupDismissals)
}

function shouldPreserveCleanupInspection(
  candidate: WorkspaceCleanupCandidate,
  state: AppState
): boolean {
  const viewed = state.workspaceCleanupViewedCandidates[candidate.worktreeId]
  if (!viewed?.wasSuggested || viewed.fingerprint !== candidate.fingerprint) {
    return false
  }
  // Why: View is part of cleanup review. It should not make the same
  // suggested row vanish on the next scan, but this exception must expire.
  return Date.now() - viewed.viewedAt <= VIEWED_FROM_CLEANUP_MS
}

function applyDismissal(
  candidate: WorkspaceCleanupCandidate,
  dismissals: Record<string, WorkspaceCleanupDismissal>
): WorkspaceCleanupCandidate {
  if (
    !shouldHideWorkspaceCleanupCandidate(
      candidate,
      getWorkspaceCleanupDismissal(candidate, dismissals)
    )
  ) {
    return candidate
  }
  return applyWorkspaceCleanupPolicy({
    ...candidate,
    blockers: [...new Set<WorkspaceCleanupBlocker>([...candidate.blockers, 'dismissed'])]
  })
}

function getWorkspaceCleanupDismissal(
  candidate: WorkspaceCleanupCandidate,
  dismissals: Record<string, WorkspaceCleanupDismissal>
): WorkspaceCleanupDismissal | undefined {
  return (
    dismissals[getWorkspaceCleanupCandidateIdentity(candidate)] ?? dismissals[candidate.worktreeId]
  )
}

function pruneWorkspaceCleanupDismissals(
  dismissals: Record<string, WorkspaceCleanupDismissal>,
  removedIds: ReadonlySet<string>
): Record<string, WorkspaceCleanupDismissal> {
  if (!Object.values(dismissals).some((dismissal) => removedIds.has(dismissal.worktreeId))) {
    return dismissals
  }
  return Object.fromEntries(
    Object.entries(dismissals).filter(([, dismissal]) => !removedIds.has(dismissal.worktreeId))
  )
}

function pruneWorkspaceCleanupRecord<T>(
  record: Record<string, T>,
  removedIds: ReadonlySet<string>
): Record<string, T> {
  if (!Object.keys(record).some((id) => removedIds.has(id))) {
    return record
  }
  return Object.fromEntries(Object.entries(record).filter(([id]) => !removedIds.has(id)))
}

function buildWorkspaceCleanupAgentStatusIndex(
  state: AppState,
  includedTabIds?: ReadonlySet<string>
): Map<string, AgentStatusEntry[]> {
  const agentStatusesByTabId = new Map<string, AgentStatusEntry[]>()
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    const tabId = getPaneKeyTabId(entry.paneKey)
    if (includedTabIds && !includedTabIds.has(tabId)) {
      continue
    }
    const entries = agentStatusesByTabId.get(tabId) ?? []
    entries.push(entry)
    agentStatusesByTabId.set(tabId, entries)
  }
  return agentStatusesByTabId
}

function hasFreshIndexedLiveAgent(
  agentStatusesByTabId: ReadonlyMap<string, readonly AgentStatusEntry[]>,
  tabIds: Set<string>
): boolean {
  const now = Date.now()
  for (const tabId of tabIds) {
    for (const entry of agentStatusesByTabId.get(tabId) ?? []) {
      if (
        isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS) &&
        (entry.state === 'working' || entry.state === 'blocked' || entry.state === 'waiting')
      ) {
        return true
      }
    }
  }
  return false
}

function hasWorkingTitleAgent(state: AppState, tabs: { id: string; title: string }[]): boolean {
  for (const tab of tabs) {
    if ((state.ptyIdsByTabId[tab.id]?.length ?? 0) === 0) {
      continue
    }
    const paneTitles = state.runtimePaneTitlesByTabId[tab.id]
    const titles =
      paneTitles && Object.keys(paneTitles).length > 0 ? Object.values(paneTitles) : [tab.title]
    for (const title of titles) {
      const status = classifyTitleActivity(title)
      if (status === 'working' || status === 'permission') {
        return true
      }
    }
  }
  return false
}

async function probeTerminalLiveness(
  state: AppState,
  tabs: { id: string; title: string }[]
): Promise<'idle' | 'running' | 'unknown'> {
  const ptyChecks = tabs.flatMap((tab) =>
    (state.ptyIdsByTabId[tab.id] ?? []).map((ptyId) => ({ tab, ptyId }))
  )
  if (ptyChecks.length === 0) {
    return 'idle'
  }

  let unknown = false
  for (const { tab, ptyId } of ptyChecks) {
    try {
      const [hasChildProcesses, foregroundProcess] = await Promise.all([
        window.api.pty.hasChildProcesses(ptyId),
        window.api.pty.getForegroundProcess(ptyId)
      ])
      const processName = normalizeProcessName(foregroundProcess)
      if (!hasChildProcesses && (!processName || SHELL_PROCESS_NAMES.has(processName))) {
        continue
      }
      if (
        processName &&
        AGENT_PROCESS_NAMES.has(processName) &&
        hasIdleAgentTitleForPty(state, tab, ptyId)
      ) {
        continue
      }
      return 'running'
    } catch {
      unknown = true
    }
  }

  return unknown ? 'unknown' : 'idle'
}

function hasIdleAgentTitleForPty(
  state: AppState,
  tab: { id: string; title: string },
  ptyId: string
): boolean {
  const paneTitles = state.runtimePaneTitlesByTabId[tab.id] ?? {}
  const layoutPtyIds = state.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId ?? {}
  const matchingTitles = Object.entries(layoutPtyIds)
    .filter(([, leafPtyId]) => leafPtyId === ptyId)
    .map(([leafId]) => paneTitles[leafId.replace(/^pane:/, '')])
    .filter((title): title is string => typeof title === 'string')

  if (matchingTitles.length > 0) {
    return matchingTitles.some(isIdleAgentTitle)
  }

  // Why: without a pane->PTY binding, a tab-level idle title is safe evidence
  // only when this tab has a single live PTY. Multi-pane tabs stay protected.
  const tabPtyIds = state.ptyIdsByTabId[tab.id] ?? []
  if (tabPtyIds.length !== 1) {
    return false
  }

  const titles = Object.keys(paneTitles).length > 0 ? Object.values(paneTitles) : [tab.title]
  return titles.some(isIdleAgentTitle)
}

function isIdleAgentTitle(title: string): boolean {
  return classifyTitleActivity(title) === 'idle'
}

function getPaneKeyTabId(paneKey: AgentStatusEntry['paneKey']): string {
  const separatorIndex = paneKey.lastIndexOf(':')
  return separatorIndex === -1 ? paneKey : paneKey.slice(0, separatorIndex)
}

function normalizeProcessName(value: string | null): string | null {
  if (!value) {
    return null
  }
  const normalizedPath = value.replace(/\\/g, '/')
  const name = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1).toLowerCase()
  // Why: Windows reports `claude.exe`/`cmd.exe`; the name sets hold bare names.
  return name.replace(/\.exe$/, '')
}
