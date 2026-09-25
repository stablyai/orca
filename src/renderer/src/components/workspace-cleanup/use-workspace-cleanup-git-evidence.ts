import { useCallback, useEffect, useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import {
  selectWorkspaceCleanupGitEvidenceTargets,
  WORKSPACE_CLEANUP_GIT_EVIDENCE_MAX_TARGETS
} from './workspace-cleanup-git-evidence'

export type WorkspaceCleanupGitEvidenceState = {
  /** Focused re-scan results, keyed by host-qualified identity. */
  evidenceByIdentity: ReadonlyMap<string, WorkspaceCleanupCandidate>
  pendingWorktreeIds: ReadonlySet<string>
  checkedCount: number
  totalCount: number
}

const EMPTY_EVIDENCE: WorkspaceCleanupGitEvidenceState = {
  evidenceByIdentity: new Map(),
  pendingWorktreeIds: new Set(),
  checkedCount: 0,
  totalCount: 0
}

/**
 * Fills in git evidence the broad scan deferred with targeted batch scans.
 * The initial list render never waits on these requests, so the browse stays
 * responsive while each row transitions from an unknown status to its result.
 */
export function useWorkspaceCleanupGitEvidence({
  enabled,
  candidates,
  scannedAt
}: {
  enabled: boolean
  candidates: readonly WorkspaceCleanupCandidate[]
  scannedAt: number | null
}): WorkspaceCleanupGitEvidenceState {
  const mountedRef = useMountedRef()
  const [state, setState] = useState<WorkspaceCleanupGitEvidenceState>(EMPTY_EVIDENCE)
  const evidenceRef = useRef(new Map<string, WorkspaceCleanupCandidate>())
  const attemptedRef = useRef(new Set<string>())
  const queueRef = useRef<string[]>([])
  const queuedRef = useRef(new Set<string>())
  const inFlightRef = useRef(new Set<string>())
  // Why: restarted filters must share one physical RPC/subprocess cap.
  const activeRequestWorktreeIdsRef = useRef(new Set<string>())
  const activeScanIdRef = useRef<string | null>(null)
  const totalRef = useRef(0)
  const enabledRef = useRef(enabled)
  const scannedAtRef = useRef(scannedAt)
  // Why: results that land after the user cleared the git filter belong to a
  // stale pass and must not resurrect its pending banner.
  const generationRef = useRef(0)

  // Why: streaming ticks call publish repeatedly; unchanged evidence must not
  // mint new Map/Set identities or every subscriber re-renders per tick.
  const publishDirtyRef = useRef(false)
  const publish = useCallback(() => {
    if (!mountedRef.current || !publishDirtyRef.current) {
      return
    }
    publishDirtyRef.current = false
    setState({
      evidenceByIdentity: new Map(evidenceRef.current),
      pendingWorktreeIds: new Set([...queuedRef.current, ...inFlightRef.current]),
      checkedCount: totalRef.current - queuedRef.current.size - inFlightRef.current.size,
      totalCount: totalRef.current
    })
  }, [mountedRef])

  const pump = useCallback(() => {
    if (activeRequestWorktreeIdsRef.current.size > 0 || queueRef.current.length === 0) {
      publish()
      return
    }
    const generation = generationRef.current
    // Why: main truncates targeted scans at this shared limit; a larger request
    // would silently drop the overflow ids while marking them attempted.
    const worktreeIds = queueRef.current.slice(0, WORKSPACE_CLEANUP_GIT_EVIDENCE_MAX_TARGETS)
    queueRef.current = queueRef.current.slice(worktreeIds.length)
    const scanId = crypto.randomUUID()
    activeScanIdRef.current = scanId
    for (const worktreeId of worktreeIds) {
      queuedRef.current.delete(worktreeId)
      inFlightRef.current.add(worktreeId)
      activeRequestWorktreeIdsRef.current.add(worktreeId)
      attemptedRef.current.add(worktreeId)
    }
    publishDirtyRef.current = true
    const acceptCandidates = (nextCandidates: readonly WorkspaceCleanupCandidate[]): void => {
      if (generation !== generationRef.current) {
        return
      }
      for (const candidate of nextCandidates) {
        if (!activeRequestWorktreeIdsRef.current.has(candidate.worktreeId)) {
          continue
        }
        evidenceRef.current.set(getWorkspaceCleanupCandidateIdentity(candidate), candidate)
        inFlightRef.current.delete(candidate.worktreeId)
        publishDirtyRef.current = true
      }
      publish()
    }
    void window.api.workspaceCleanup
      .scan({ worktreeIds, scanId }, (progress) => acceptCandidates(progress.candidates))
      .then((result) => acceptCandidates(result.candidates))
      .catch(() => {
        // Why: a failed targeted scan leaves rows honestly "Not checked";
        // attemptedRef keeps it from retrying in a loop.
      })
      .finally(() => {
        if (activeScanIdRef.current === scanId) {
          activeScanIdRef.current = null
        }
        for (const worktreeId of worktreeIds) {
          activeRequestWorktreeIdsRef.current.delete(worktreeId)
          if (generation === generationRef.current && inFlightRef.current.delete(worktreeId)) {
            publishDirtyRef.current = true
          }
        }
        pump()
      })
    publish()
  }, [publish])

  useEffect(() => {
    const wasEnabled = enabledRef.current
    const snapshotChanged = scannedAtRef.current !== scannedAt
    enabledRef.current = enabled
    scannedAtRef.current = scannedAt

    if ((wasEnabled && !enabled) || (enabled && snapshotChanged)) {
      generationRef.current += 1
      const activeScanId = activeScanIdRef.current
      if (activeScanId) {
        void window.api.workspaceCleanup.cancelScan?.(activeScanId)
      }
      queueRef.current = []
      queuedRef.current.clear()
      inFlightRef.current.clear()
      attemptedRef.current.clear()
      evidenceRef.current.clear()
      totalRef.current = 0
      publishDirtyRef.current = true
      publish()
    }
    if (!enabled) {
      return
    }
    // Why: the exclusion set must cover queued/in-flight ids too — a cap that
    // counts them would permanently skip everything past it on a settled scan.
    const targets = selectWorkspaceCleanupGitEvidenceTargets(candidates, {
      resolvedWorktreeIds: new Set([
        ...attemptedRef.current,
        ...queuedRef.current,
        ...inFlightRef.current
      ]),
      maxTargets: Number.POSITIVE_INFINITY
    })
    if (targets.length === 0) {
      return
    }
    queueRef.current.push(...targets)
    for (const target of targets) {
      queuedRef.current.add(target)
    }
    totalRef.current += targets.length
    publishDirtyRef.current = true
    pump()
  }, [candidates, enabled, pump, publish, scannedAt])

  useEffect(
    () => () => {
      const activeScanId = activeScanIdRef.current
      if (activeScanId) {
        void window.api.workspaceCleanup.cancelScan?.(activeScanId)
      }
    },
    []
  )

  return state
}
