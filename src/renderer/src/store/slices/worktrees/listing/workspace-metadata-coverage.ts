import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorkspaceMetadataCursor } from '../../../../../../shared/worktree/workspace-metadata-set'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import { getWorkspaceReferenceIdentity } from '../../../../../../shared/workspace-attachments/workspace-reference-identity'
import { getRuntimeEnvironmentRevision } from '../../../../runtime/rpc/environment-revisions/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '../../runtime-status/runtime-status-connection-generation'
import type { AppState } from '../../../types'
import { selectWorktreesByRepo } from '../../../workspaces/catalog/workspace-record-fields'
import { worktreeHostMatchOptions, worktreeMatchesHost } from './worktree-host-ownership'
import type { AdmittedDetectedWorktreeRefresh } from './worktree-slice-types'
import type { WorktreeFetchOptions } from './worktree-fetch-options'
import { requestWorkspaceMetadataRecovery } from './workspace-metadata-recovery'

// One producer's workspaceMetadata stream as this client has seen it: the last record seq, and per listed
// projection (repo on a host) the newest record that touched it and whether a covering listing landed since.
type Projection = { repoId: string; hostId: ExecutionHostId; latest: number; pending: boolean }
type ProducerCoverage = { epoch: string; lastSeq: number; projections: Map<string, Projection> }

const producers = new Map<string, ProducerCoverage>()

const projectionKey = (repoId: string, hostId: ExecutionHostId): string =>
  `${hostId}\u0000${repoId}`

/**
 * The producer whose cursor a host's listings and records share: this app's own main for local and
 * SSH rows, or a paired environment for its rows, keyed by that pairing and connection.
 */
export function workspaceMetadataProducerKey(hostId: ExecutionHostId): string {
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind !== 'runtime') {
    return 'local'
  }
  const environmentId = parsed.environmentId
  return `env:${environmentId}:${getRuntimeEnvironmentRevision(environmentId) ?? ''}:${getRuntimeEnvironmentConnectionGeneration(environmentId)}`
}

function producerFor(key: string, epoch: string): ProducerCoverage {
  const current = producers.get(key)
  if (current?.epoch === epoch) {
    return current
  }
  // A new epoch is a restarted producer: what it lists already includes its earlier writes.
  const fresh = { epoch, lastSeq: 0, projections: new Map<string, Projection>() }
  if (key.startsWith('env:')) {
    // A re-paired or reconnected environment is a new producer; its earlier bookkeeping dies here.
    const environmentPrefix = key.slice(0, key.indexOf(':', 4) + 1)
    for (const other of producers.keys()) {
      if (other !== key && other.startsWith(environmentPrefix)) {
        producers.delete(other)
      }
    }
  }
  producers.set(key, fresh)
  return fresh
}

/**
 * Notes a record before it is applied. `replayed` records are dropped; a `gap` means some earlier
 * record was missed and its projection is unknown, so every projection of this producer needs a
 * covering listing. Projections no longer listed here are forgotten.
 */
export function noteWorkspaceMetadataRecord(
  key: string,
  epoch: string,
  seq: number,
  repoId: string,
  hostId: ExecutionHostId,
  isListed: (repoId: string, hostId: ExecutionHostId) => boolean
): { replayed: boolean; gap: boolean } {
  const producer = producerFor(key, epoch)
  if (seq <= producer.lastSeq) {
    return { replayed: true, gap: false }
  }
  const gap = producer.lastSeq > 0 && seq > producer.lastSeq + 1
  producer.lastSeq = seq
  for (const [projection, entry] of producer.projections) {
    if (!isListed(entry.repoId, entry.hostId)) {
      producer.projections.delete(projection)
    }
  }
  producer.projections.set(projectionKey(repoId, hostId), {
    repoId,
    hostId,
    latest: seq,
    pending: true
  })
  return { replayed: false, gap }
}

/** After a gap, every listed projection of the producer must be listed again at or past the last seq. */
export function requireWorkspaceMetadataCoverage(
  key: string,
  projections: Iterable<{ repoId: string; hostId: ExecutionHostId }>
): void {
  const producer = producers.get(key)
  if (!producer) {
    return
  }
  for (const { repoId, hostId } of projections) {
    producer.projections.set(projectionKey(repoId, hostId), {
      repoId,
      hostId,
      latest: producer.lastSeq,
      pending: true
    })
  }
}

/**
 * Where a listing stands against the newest record that touched its projection. `stale` read before
 * that record; `unstamped` comes from a path or host that doesn't say; `unknown` has nothing to check.
 */
export function workspaceMetadataListingCoverage(
  key: string,
  repoId: string,
  hostId: ExecutionHostId,
  stamp: WorkspaceMetadataCursor | undefined
): 'covered' | 'stale' | 'unstamped' | 'unknown' {
  const producer = producers.get(key)
  const projection = producer?.projections.get(projectionKey(repoId, hostId))
  if (!producer || !projection) {
    return 'unknown'
  }
  if (!stamp) {
    return 'unstamped'
  }
  // A different epoch read after a restart, so it includes everything the old epoch wrote.
  return stamp.epoch !== producer.epoch || stamp.seq >= projection.latest ? 'covered' : 'stale'
}

/** Whether the projection still waits for a listing that includes its newest record. */
function isPending(key: string, repoId: string, hostId: ExecutionHostId): boolean {
  return producers.get(key)?.projections.get(projectionKey(repoId, hostId))?.pending === true
}

/**
 * A covering listing ends the wait. The projection keeps its newest seq, so a listing that read before
 * it and lands later is still recognised as stale.
 */
export function settleWorkspaceMetadataCoverage(
  key: string,
  repoId: string,
  hostId: ExecutionHostId
): void {
  const projection = producers.get(key)?.projections.get(projectionKey(repoId, hostId))
  if (projection) {
    projection.pending = false
  }
}

/**
 * A listing that read metadata before a published write must not erase what that write already showed:
 * keep the current rows' issue titles on the same, still-untitled links. Never adds or restores a link.
 */
function keepPublishedLinkTitles<T extends Worktree>(
  incoming: T[],
  current: readonly Worktree[]
): T[] {
  const currentById = new Map(current.map((row) => [row.id, row]))
  return incoming.map((row) => {
    const previous = currentById.get(row.id)
    if (!previous) {
      return row
    }
    const titles = new Map<string, string>()
    for (const item of getWorkspaceAttachments(previous)) {
      const title = item.title?.trim()
      if (item.provider === 'github' && item.type === 'issue' && title) {
        titles.set(getWorkspaceReferenceIdentity(item), title)
      }
    }
    if (titles.size === 0) {
      return row
    }
    let kept = false
    const linkedItems = getWorkspaceAttachments(row).map((item) => {
      const title = item.title?.trim() ? undefined : titles.get(getWorkspaceReferenceIdentity(item))
      if (!title) {
        return item
      }
      kept = true
      return { ...item, title }
    })
    return kept ? { ...row, linkedItems } : row
  })
}

type FetchWorktrees = (repoId: string, options: WorktreeFetchOptions) => Promise<unknown>

/**
 * A listing's place against the records its repo is waiting on, checked right before it is merged: a
 * stale listing keeps already-shown titles and, once applied, asks for a fresh listing; a covering one
 * ends the repo's obligation.
 */
export function listingMetadataCoverage(
  state: AppState,
  repoId: string,
  hostId: ExecutionHostId,
  refresh: AdmittedDetectedWorktreeRefresh
): { refresh: AdmittedDetectedWorktreeRefresh; settle: (fetchWorktrees: FetchWorktrees) => void } {
  const key = workspaceMetadataProducerKey(hostId)
  const coverage = workspaceMetadataListingCoverage(
    key,
    repoId,
    hostId,
    refresh.result.workspaceMetadata
  )
  const matchOptions = worktreeHostMatchOptions(state, repoId, hostId)
  const current = (selectWorktreesByRepo(state)[repoId] ?? []).filter((row) =>
    worktreeMatchesHost(row, hostId, matchOptions)
  )
  // Keeping titles already shown is always safe (it never adds or restores a link), so any listing that
  // can't prove it includes the newest record keeps them.
  const keep = coverage === 'stale' || coverage === 'unstamped'
  return {
    refresh: keep
      ? {
          ...refresh,
          result: {
            ...refresh.result,
            worktrees: keepPublishedLinkTitles(refresh.result.worktrees, current)
          }
        }
      : refresh,
    settle: (fetchWorktrees) => {
      if (coverage === 'covered') {
        settleWorkspaceMetadataCoverage(key, repoId, hostId)
      } else if (coverage === 'stale' && isPending(key, repoId, hostId)) {
        requestWorkspaceMetadataRecovery(repoId, hostId, fetchWorktrees)
      }
    }
  }
}
