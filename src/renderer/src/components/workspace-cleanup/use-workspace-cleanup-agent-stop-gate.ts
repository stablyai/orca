import { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import { findWorkspaceCleanupLiveAgentWorktreeIds } from '@/store/slices/workspace-cleanup-local-evidence'
import { withWorkspaceCleanupAgentStopApproval } from './workspace-cleanup-agent-stop-approval'

export type WorkspaceCleanupAgentStopRequest = {
  /** Workspaces with a live agent at the last delete click, in confirmation order. */
  candidates: WorkspaceCleanupCandidate[]
  /** Set when the step guards a row's "Delete anyway" rather than the confirmed batch. */
  unverifiedCandidate: WorkspaceCleanupCandidate | null
}

export type WorkspaceCleanupAgentStopGate = {
  request: WorkspaceCleanupAgentStopRequest | null
  /**
   * Reads live agents now; returns the candidates stamped with the user's agent-stop approval,
   * or null after opening (or refreshing) the stop step for agents the user has not approved.
   */
  approve: (
    candidates: readonly WorkspaceCleanupCandidate[],
    unverifiedCandidate: WorkspaceCleanupCandidate | null
  ) => WorkspaceCleanupCandidate[] | null
  clear: () => void
}

export function useWorkspaceCleanupAgentStopGate(): WorkspaceCleanupAgentStopGate {
  const [request, setRequest] = useState<WorkspaceCleanupAgentStopRequest | null>(null)

  const approve = useCallback<WorkspaceCleanupAgentStopGate['approve']>(
    (candidates, unverifiedCandidate) => {
      // Why: the scan snapshot can be minutes old; an agent may have started since.
      const liveWorktreeIds = findWorkspaceCleanupLiveAgentWorktreeIds(
        useAppStore.getState(),
        candidates.map((candidate) => candidate.worktreeId)
      )
      const approvedIdentities = new Set(
        request && isSameAction(request, unverifiedCandidate)
          ? request.candidates.map(getWorkspaceCleanupCandidateIdentity)
          : []
      )
      const liveCandidates = candidates.filter((candidate) =>
        liveWorktreeIds.has(candidate.worktreeId)
      )
      if (
        liveCandidates.some(
          (candidate) => !approvedIdentities.has(getWorkspaceCleanupCandidateIdentity(candidate))
        )
      ) {
        setRequest({ candidates: liveCandidates, unverifiedCandidate })
        return null
      }
      setRequest(null)
      return candidates.map((candidate) =>
        withWorkspaceCleanupAgentStopApproval(
          candidate,
          approvedIdentities.has(getWorkspaceCleanupCandidateIdentity(candidate))
        )
      )
    },
    [request]
  )

  const clear = useCallback(() => setRequest(null), [])

  return { request, approve, clear }
}

function isSameAction(
  request: WorkspaceCleanupAgentStopRequest,
  unverifiedCandidate: WorkspaceCleanupCandidate | null
): boolean {
  if (request.unverifiedCandidate === null || unverifiedCandidate === null) {
    return request.unverifiedCandidate === unverifiedCandidate
  }
  return (
    getWorkspaceCleanupCandidateIdentity(request.unverifiedCandidate) ===
    getWorkspaceCleanupCandidateIdentity(unverifiedCandidate)
  )
}
