import { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import { getWorkspaceCleanupAgentEvidence } from '@/store/slices/workspace-cleanup-agent-evidence'
import { withWorkspaceCleanupAgentStopApproval } from './workspace-cleanup-agent-stop-approval'

export type WorkspaceCleanupAgentStopRequest = {
  candidates: WorkspaceCleanupCandidate[]
  unverifiedCandidate: WorkspaceCleanupCandidate | null
}

export type WorkspaceCleanupAgentStopGate = {
  request: WorkspaceCleanupAgentStopRequest | null
  /** Read live agents at delete time; return approved candidates or show/refresh stop confirmation for unapproved agents. */
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
      const agentEvidence = getWorkspaceCleanupAgentEvidence(useAppStore.getState(), candidates)
      const approvedIdentities = new Set(
        request && isSameAction(request, unverifiedCandidate)
          ? request.candidates.map(getWorkspaceCleanupCandidateIdentity)
          : []
      )
      const liveCandidates = candidates.filter(
        (candidate) => agentEvidence.get(getWorkspaceCleanupCandidateIdentity(candidate)) === 'live'
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
