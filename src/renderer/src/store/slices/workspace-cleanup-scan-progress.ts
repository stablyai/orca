import type { AppState } from '../types'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanProgress
} from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import { supersedeInFlightWorkspaceCleanupScans } from './workspace-cleanup-broad-scan-registry'
import {
  applyWorkspaceCleanupDismissal,
  enrichWorkspaceCleanupCandidatesWithCache,
  type WorkspaceCleanupEnrichmentCacheEntry
} from './workspace-cleanup-candidate-enrichment'
import { selectDetectedWorktreesByRepo, selectWorktreesByRepo } from '../workspace-record-selectors'

let latestWorkspaceCleanupScanToken = 0
let finalizedWorkspaceCleanupScanToken = 0
let workspaceCleanupProgressQueue: { scanToken: number; promise: Promise<void> } | null = null
let workspaceCleanupEnrichmentCache: {
  scanToken: number
  localToken: readonly unknown[] | null
  entries: Map<string, WorkspaceCleanupEnrichmentCacheEntry>
} | null = null
let workspaceCleanupProgressCandidateIndex: {
  scanToken: number
  scanId: string
  candidates: WorkspaceCleanupCandidate[]
  indexesByIdentity: Map<string, number>
} | null = null

export function beginWorkspaceCleanupScan(): number {
  const scanToken = ++latestWorkspaceCleanupScanToken
  finalizedWorkspaceCleanupScanToken = 0
  workspaceCleanupProgressQueue = null
  workspaceCleanupEnrichmentCache = { scanToken, localToken: null, entries: new Map() }
  workspaceCleanupProgressCandidateIndex = null
  return scanToken
}

export function isLatestWorkspaceCleanupScan(scanToken: number): boolean {
  return scanToken === latestWorkspaceCleanupScanToken
}

export function finalizeWorkspaceCleanupScan(scanToken: number): void {
  finalizedWorkspaceCleanupScanToken = scanToken
  workspaceCleanupEnrichmentCache = null
  workspaceCleanupProgressCandidateIndex = null
}

export function invalidateWorkspaceCleanupScanProgress(): void {
  latestWorkspaceCleanupScanToken += 1
  finalizedWorkspaceCleanupScanToken = 0
  supersedeInFlightWorkspaceCleanupScans(window.api.workspaceCleanup.cancelScan)
  workspaceCleanupProgressQueue = null
  workspaceCleanupEnrichmentCache = null
  workspaceCleanupProgressCandidateIndex = null
}

export function enqueueWorkspaceCleanupProgress(
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
export async function drainWorkspaceCleanupProgressQueue(scanToken: number): Promise<void> {
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
  // Reconcile streamed rows into cached/settled snapshots without clearing the list under the reader.
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
    // Dismissals may commit during enrichment; do not overwrite them with pre-await candidates.
    const finalCandidates =
      state.workspaceCleanupDismissals === dismissalsAtEnrichment
        ? candidates
        : candidates.map((candidate) =>
            applyWorkspaceCleanupDismissal(candidate, state.workspaceCleanupDismissals)
          )
    return {
      workspaceCleanupScan: {
        // Mixed old/new rows retain snapshot’s as-of time until settlement removes vanished rows.
        scannedAt: state.workspaceCleanupScan?.scannedAt ?? progress.scannedAt,
        candidates: finalCandidates,
        errors: progress.errors
      },
      workspaceCleanupProgress: { ...progress, candidates: finalCandidates }
    }
  })
}

export async function enrichWorkspaceCleanupCandidatesForScan(
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

/** Reference token covers a superset of local-signature inputs; equality skips signature stringification. */
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
    state.unifiedTabsByWorktree,
    selectWorktreesByRepo(state),
    selectDetectedWorktreesByRepo(state),
    state.runtimeAgentOrchestrationByPaneKey,
    state.paneForegroundAgentByPaneKey,
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
    // Merge host-qualified identities or same-ID rows overwrite the other host (STA-4343).
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
