import type { AppState } from '../types'
import type {
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import {
  getInFlightWorkspaceCleanupScan,
  hasInFlightWorkspaceCleanupScan,
  normalizeWorkspaceCleanupScanError,
  registerInFlightWorkspaceCleanupScan,
  releaseInFlightWorkspaceCleanupScan,
  supersedeInFlightWorkspaceCleanupScans,
  throwIfWorkspaceCleanupScanSuperseded
} from './workspace-cleanup-broad-scan-registry'
import { enrichWorkspaceCleanupCandidates } from './workspace-cleanup-candidate-enrichment'
import { getInitialWorkspaceCleanupGitDeferrals } from './workspace-cleanup-local-evidence'
import {
  beginWorkspaceCleanupScan,
  drainWorkspaceCleanupProgressQueue,
  enqueueWorkspaceCleanupProgress,
  enrichWorkspaceCleanupCandidatesForScan,
  finalizeWorkspaceCleanupScan,
  isLatestWorkspaceCleanupScan
} from './workspace-cleanup-scan-progress'

type SetState = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
  replace?: false
) => void

export async function scanWorkspaceCleanup(
  get: () => AppState,
  set: SetState,
  args?: WorkspaceCleanupScanArgs
): Promise<WorkspaceCleanupScanResult> {
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
  const scanToken = beginWorkspaceCleanupScan()
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
      if (isLatestWorkspaceCleanupScan(scanToken)) {
        finalizeWorkspaceCleanupScan(scanToken)
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
    if (isLatestWorkspaceCleanupScan(scanToken)) {
      set({ workspaceCleanupError: message, workspaceCleanupLoading: false })
    }
    throw error
  } finally {
    releaseInFlightWorkspaceCleanupScan(scanKey, scanArgs.scanId, promise)
  }
}

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
