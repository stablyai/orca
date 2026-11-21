import { useEffect } from 'react'
import type { GitUpstreamStatus } from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import type { OrcaRebaseMarker } from '../panel/worktree-operation-store'
import { orcaRebaseMarkerIsRetired, orcaRebaseMarkerMatches } from './orca-rebase-marker'

/** After Orca's own rebase, hide Pull/Sync/FF/Push while the branch still diverges from the same tip. */
export function useOrcaRebaseMarker({
  branchName,
  operationStore,
  orcaRebase,
  remoteStatus
}: {
  branchName: string
  operationStore: SourceControlWorktreeOperationState['operationStore']
  orcaRebase: OrcaRebaseMarker | null
  remoteStatus: GitUpstreamStatus | undefined
}): boolean {
  const applies =
    orcaRebase !== null && orcaRebaseMarkerMatches(orcaRebase, branchName, remoteStatus)
  const retired =
    orcaRebase !== null && orcaRebaseMarkerIsRetired(orcaRebase, branchName, remoteStatus)
  // Readings right after the rebase are still pre-rebase ones; only a seen match arms mismatch retirement.
  const promote = applies && orcaRebase?.state === 'done'
  useEffect(() => {
    const current = operationStore.getState().orcaRebase
    if (retired) {
      operationStore.setState({ orcaRebase: null })
    } else if (promote && current) {
      operationStore.setState({ orcaRebase: { ...current, state: 'active' } })
    }
  }, [operationStore, promote, retired])
  return applies && !retired
}
