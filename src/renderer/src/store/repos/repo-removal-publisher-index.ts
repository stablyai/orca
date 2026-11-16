import type { AppState } from '../types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '../workspaces/catalog/workspace-record-fields'

export type PurgePublisher = {
  id: string
  hostId?: ExecutionHostId
  runtimeOwnerEnvironmentId?: string
}

type Publishers = {
  rows: PurgePublisher[]
  firstByHost: Map<ExecutionHostId, PurgePublisher>
}

const indexes = new WeakMap<readonly PurgePublisher[], Map<string, Publishers>>()

function publishersIn(rows: readonly PurgePublisher[] | undefined, id: string) {
  if (!rows) {
    return undefined
  }
  let index = indexes.get(rows)
  if (!index) {
    index = new Map()
    for (const row of rows) {
      const id = row.id
      let entry = index.get(id)
      if (!entry) {
        entry = { rows: [], firstByHost: new Map() }
        index.set(id, entry)
      }
      entry.rows.push(row)
      const hostId = row.hostId
      if (hostId && !entry.firstByHost.has(hostId)) {
        entry.firstByHost.set(hostId, row)
      }
    }
    indexes.set(rows, index)
  }
  return index.get(id)
}

type PublisherState = Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>

/** Ordered publications stay repo-scoped; exact host lookup retains the first tracked row. */
export function worktreePurgePublishers(state: PublisherState, worktreeId: string) {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const tracked = publishersIn(selectWorktreesByRepo(state)[repoId], worktreeId)
  const detected = publishersIn(selectDetectedWorktreesByRepo(state)[repoId]?.worktrees, worktreeId)
  return {
    rows: () => [...(tracked?.rows ?? []), ...(detected?.rows ?? [])],
    firstForHost: (hostId: ExecutionHostId) =>
      tracked?.firstByHost.get(hostId) ?? detected?.firstByHost.get(hostId)
  }
}
