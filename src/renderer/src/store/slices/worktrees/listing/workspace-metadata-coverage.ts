import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorkspaceMetadataCursor } from '../../../../../../shared/worktree/metadata/workspace-metadata-set'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import { getWorkspaceReferenceIdentity } from '../../../../../../shared/workspace-attachments/workspace-reference-identity'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentsRetired
} from '../../../../runtime/rpc/environment-revisions/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '../../runtime-status/runtime-status-connection-generation'
import type { AppState } from '../../../types'
import { selectWorktreesByRepo } from '../../../workspaces/catalog/workspace-record-fields'
import { worktreeHostMatchOptions, worktreeMatchesHost } from './worktree-host-ownership'
import type { AdmittedDetectedWorktreeRefresh } from './worktree-slice-types'
import type { WorktreeFetchOptions } from './worktree-fetch-options'
import { requestWorkspaceMetadataRecovery } from './workspace-metadata-recovery'

// One producer's workspaceMetadata stream as this client has seen it: the last record seq, and per listed
// projection (repo on a host) the newest record that touched it.
type Projection = { repoId: string; hostId: ExecutionHostId; latest: number }
type ProducerCoverage = { epoch: string; lastSeq: number; projections: Map<string, Projection> }

const producers = new Map<string, ProducerCoverage>()

// Encoded: environment ids (WSL ones) may contain ':', which would let one id prefix another's keys.
const environmentKeyPrefix = (environmentId: string): string =>
  `env:${encodeURIComponent(environmentId)}:`

function dropEnvironmentProducers(environmentId: string, except?: string): void {
  for (const key of producers.keys()) {
    if (key !== except && key.startsWith(environmentKeyPrefix(environmentId))) {
      producers.delete(key)
    }
  }
}

// A removed or re-pointed environment's stream ends with it.
onRuntimeEnvironmentsRetired((environmentIds) => {
  for (const environmentId of environmentIds) {
    dropEnvironmentProducers(environmentId)
  }
})

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
  return `${environmentKeyPrefix(environmentId)}${getRuntimeEnvironmentRevision(environmentId) ?? ''}:${getRuntimeEnvironmentConnectionGeneration(environmentId)}`
}

function producerFor(key: string, epoch: string, hostId: ExecutionHostId): ProducerCoverage {
  const current = producers.get(key)
  if (current?.epoch === epoch) {
    return current
  }
  // A new epoch is a restarted producer: what it lists already includes its earlier writes.
  const fresh = { epoch, lastSeq: 0, projections: new Map<string, Projection>() }
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind === 'runtime') {
    // A reconnected environment is a new producer; its earlier bookkeeping dies here.
    dropEnvironmentProducers(parsed.environmentId, key)
  }
  producers.set(key, fresh)
  return fresh
}

/**
 * Notes a record before it is applied. `replayed` records are dropped; a `gap` means some earlier
 * record was missed and its projection is unknown, so every projection of this producer needs a
 * covering listing. A projection seen for the first time forgets those no longer listed here.
 */
export function noteWorkspaceMetadataRecord(
  key: string,
  epoch: string,
  seq: number,
  repoId: string,
  hostId: ExecutionHostId,
  isListed: (repoId: string, hostId: ExecutionHostId) => boolean
): { replayed: boolean; gap: boolean } {
  const producer = producerFor(key, epoch, hostId)
  if (seq <= producer.lastSeq) {
    return { replayed: true, gap: false }
  }
  const gap = producer.lastSeq > 0 && seq > producer.lastSeq + 1
  producer.lastSeq = seq
  const recorded = projectionKey(repoId, hostId)
  if (!producer.projections.has(recorded)) {
    for (const [projection, entry] of producer.projections) {
      if (!isListed(entry.repoId, entry.hostId)) {
        producer.projections.delete(projection)
      }
    }
  }
  producer.projections.set(recorded, { repoId, hostId, latest: seq })
  return { replayed: false, gap }
}

/**
 * After a gap, every listed projection of the producer must be listed again at or past the last seq;
 * the live projections replace all earlier ones.
 */
export function requireWorkspaceMetadataCoverage(
  key: string,
  projections: Iterable<{ repoId: string; hostId: ExecutionHostId }>
): void {
  const producer = producers.get(key)
  if (!producer) {
    return
  }
  producer.projections = new Map(
    [...projections].map(({ repoId, hostId }) => [
      projectionKey(repoId, hostId),
      { repoId, hostId, latest: producer.lastSeq }
    ])
  )
}

/**
 * Where a listing stands against the newest record that touched its projection. `stale` read before
 * that record; `unstamped` comes from a path, host or producer run that can't say; `unknown` has nothing to check.
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
  // Another epoch's stamp can't be ordered against this one's records (a restart either way).
  if (!stamp || stamp.epoch !== producer.epoch) {
    return 'unstamped'
  }
  return stamp.seq >= projection.latest ? 'covered' : 'stale'
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

function currentRows(state: AppState, repoId: string, hostId: ExecutionHostId): Worktree[] {
  const matchOptions = worktreeHostMatchOptions(state, repoId, hostId)
  return (selectWorktreesByRepo(state)[repoId] ?? []).filter((row) =>
    worktreeMatchesHost(row, hostId, matchOptions)
  )
}

type FetchWorktrees = (repoId: string, options: WorktreeFetchOptions) => Promise<unknown>

/**
 * A listing's place against the newest record for its repo and host, checked right before it is
 * merged: a stale listing keeps already-shown titles and, once applied, asks for a fresh listing.
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
  // Keeping titles already shown is always safe (it never adds or restores a link), so any listing that
  // can't prove it includes the newest record keeps them.
  const keep = coverage === 'stale' || coverage === 'unstamped'
  return {
    refresh: keep
      ? {
          ...refresh,
          result: {
            ...refresh.result,
            worktrees: keepPublishedLinkTitles(
              refresh.result.worktrees,
              currentRows(state, repoId, hostId)
            )
          }
        }
      : refresh,
    settle: (fetchWorktrees) => {
      // Whatever the stale listing dropped (a newer link, say), a listing begun now includes.
      if (coverage === 'stale') {
        requestWorkspaceMetadataRecovery(repoId, hostId, fetchWorktrees)
      }
    }
  }
}
