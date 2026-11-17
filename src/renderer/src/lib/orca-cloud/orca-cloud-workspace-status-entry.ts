// How one status read changes a workspace's cached status entry. Each returns the previous entry
// object when the read changes nothing visible, so the store publishes nothing and every row
// selecting the entry keeps its reference.
import type {
  CloudWorkspaceResult,
  CloudWorkspaceStatus
} from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import { plainDataEqual } from './plain-data-equal'

export type CloudStatusEntry = {
  status: CloudWorkspaceStatus | null
  loading: boolean
  error: string | null
  fetchedAt: number | null
}

/**
 * The entry to publish when a read starts, or null to publish nothing. Only a first read (nothing
 * to show yet) or a retry after an error (its button shows the retry) says `loading`; a background
 * refresh of a good status stays silent.
 */
export function loadingStatusEntry(
  previous: CloudStatusEntry | undefined
): CloudStatusEntry | null {
  if (previous && (previous.loading || (previous.status !== null && previous.error === null))) {
    return null
  }
  return {
    status: previous?.status ?? null,
    error: previous?.error ?? null,
    fetchedAt: previous?.fetchedAt ?? null,
    loading: true
  }
}

/** The entry after a read settles (not `not_cloud`, which drops the workspace). */
export function settledStatusEntry(
  previous: CloudStatusEntry | undefined,
  result: CloudWorkspaceResult<CloudWorkspaceStatus>,
  now: number
): CloudStatusEntry {
  if (result.ok) {
    if (
      previous &&
      !previous.loading &&
      previous.error === null &&
      plainDataEqual(previous.status, result.value)
    ) {
      // Same status: only the freshness moves. fetchedAt drives refresh staleness and is shown
      // nowhere, so it is updated in place rather than republishing the entry.
      previous.fetchedAt = now
      return previous
    }
    return { status: result.value, loading: false, error: null, fetchedAt: now }
  }
  if (previous && !previous.loading && previous.error === result.message) {
    return previous
  }
  return {
    status: previous?.status ?? null,
    loading: false,
    error: result.message,
    fetchedAt: previous?.fetchedAt ?? null
  }
}
