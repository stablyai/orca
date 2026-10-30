import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'

/** Seed an empty cleanup slice from main’s snapshot; render the full list immediately while background rescan reconciles it. */
export async function hydrateWorkspaceCleanupScanFromCache({
  hasLiveScanState,
  enrich,
  apply
}: {
  /** True once live scan data exists or a broad scan runs — cache never clobbers it. */
  hasLiveScanState: () => boolean
  enrich: (candidates: readonly WorkspaceCleanupCandidate[]) => Promise<WorkspaceCleanupCandidate[]>
  apply: (scan: WorkspaceCleanupScanResult) => void
}): Promise<boolean> {
  if (hasLiveScanState()) {
    return false
  }
  let cached: WorkspaceCleanupScanResult | null
  try {
    cached = await window.api.workspaceCleanup.getCachedScan()
  } catch {
    // Why: hydration is best-effort; the rescan that follows is the recovery.
    return false
  }
  if (cached === null || hasLiveScanState()) {
    return false
  }
  const candidates = await enrich(cached.candidates)
  // Why: enrichment awaits terminal probes; a scan may have started meanwhile.
  if (hasLiveScanState()) {
    return false
  }
  apply({ ...cached, candidates })
  return true
}
