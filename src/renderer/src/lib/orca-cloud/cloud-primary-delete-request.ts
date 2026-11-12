// Which cloud row the cloud delete dialog is open for (CLOUD-PRIMARY-DELETE). Its own module so the
// delete funnel can request the dialog without importing the dialog (and the Home flows it uses).
import type { Worktree } from '../../../../shared/worktree/types'

export type CloudPrimaryDeleteTarget = Pick<
  Worktree,
  'id' | 'hostId' | 'displayName' | 'repoId' | 'branch'
> &
  Partial<Pick<Worktree, 'runtimeOwnerEnvironmentId'>>

let requested: CloudPrimaryDeleteTarget | null = null
const listeners = new Set<() => void>()

export function subscribeCloudPrimaryDelete(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function cloudPrimaryDeleteRequest(): CloudPrimaryDeleteTarget | null {
  return requested
}

/** Opens (target) or closes (null) the cloud delete dialog. */
export function requestCloudPrimaryDelete(target: CloudPrimaryDeleteTarget | null): void {
  requested = target
  listeners.forEach((listener) => listener())
}
