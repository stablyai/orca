import type {
  ContinueRebaseResult,
  GitUpstreamStatus,
  RebaseFromBaseResult
} from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import type { OrcaRebaseMarker } from '../panel/worktree-operation-store'

type OperationStore = SourceControlWorktreeOperationState['operationStore']

/** Main reports the upstream tip only when Orca's own rebase integrated it; nothing else arms the marker. */
export function orcaRebaseMarkerFromResult(
  branch: string,
  result: RebaseFromBaseResult | ContinueRebaseResult
): OrcaRebaseMarker | null {
  return branch && result.integratedUpstreamOid
    ? { branch, upstreamOid: result.integratedUpstreamOid, state: 'done' }
    : null
}

/** Store the stop a Continue/inspect reported, and arm the marker when it finished Orca's rebase. */
export function recordRebaseStopReading(
  operationStore: OperationStore,
  result: ContinueRebaseResult
): void {
  const finishedOrcaRebase =
    result.branch &&
    (result.outcome === 'completed' || result.outcome === 'completed_autostash_conflict')
      ? orcaRebaseMarkerFromResult(result.branch, result)
      : null
  operationStore.setState({
    rebaseStop: result.stop
      ? {
          token: result.stop,
          branch: result.branch ?? null,
          continueBlocked: result.outcome === 'empty' || result.outcome === 'stopped'
        }
      : null,
    ...(finishedOrcaRebase ? { orcaRebase: finishedOrcaRebase } : {})
  })
}

/** Applies only to the same branch and the same upstream tip, while still diverged. */
export function orcaRebaseMarkerMatches(
  marker: OrcaRebaseMarker,
  branchName: string,
  remoteStatus: GitUpstreamStatus | undefined
): boolean {
  return (
    remoteStatus !== undefined &&
    marker.branch === branchName &&
    remoteStatus.upstreamOid === marker.upstreamOid &&
    remoteStatus.ahead > 0 &&
    remoteStatus.behind > 0
  )
}

/** A different upstream tip retires it at once; other mismatches only after a match was seen. */
export function orcaRebaseMarkerIsRetired(
  marker: OrcaRebaseMarker,
  branchName: string,
  remoteStatus: GitUpstreamStatus | undefined
): boolean {
  // Another branch, or a detached HEAD (empty name), retires it before upstream status catches up.
  if (branchName !== marker.branch) {
    return true
  }
  if (remoteStatus === undefined) {
    return false
  }
  if (remoteStatus.upstreamOid !== undefined && remoteStatus.upstreamOid !== marker.upstreamOid) {
    return true
  }
  return marker.state === 'active' && !orcaRebaseMarkerMatches(marker, branchName, remoteStatus)
}
