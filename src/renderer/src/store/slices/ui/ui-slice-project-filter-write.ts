import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { PROJECT_REPO_FILTER_EXACT_CAPABILITY } from '../../../../../shared/project-repo-filter-capability'
import type { UISlice, UISliceGet } from './ui-slice-contract'

/** A web client's filter write carries whether its one server reads project filters exactly. */
export function getProjectFilterWrite(
  state: ReturnType<UISliceGet>,
  ids: readonly string[]
): UISlice['persistedUIProjectFilterWrite'] {
  const environment =
    isWebClientLocation() && state.runtimeEnvironments.length === 1
      ? state.runtimeEnvironments[0]
      : null
  if (!environment) {
    return undefined
  }
  const snapshot = state.runtimeStatusByEnvironmentId.get(environment.id)?.snapshot
  const pairingRevision = environment.pairingRevision ?? environment.createdAt
  const readable =
    snapshot?.verification === 'verified' &&
    snapshot.transport === 'ready' &&
    !snapshot.retired &&
    snapshot.pairingRevision === pairingRevision
  return {
    ids,
    intent: {
      environmentId: environment.id,
      pairingRevision,
      exact:
        !readable ||
        snapshot.status?.capabilities?.includes(PROJECT_REPO_FILTER_EXACT_CAPABILITY) === true
    }
  }
}
