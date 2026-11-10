import {
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorkspaceMetadataSet } from '../../../../../../shared/worktree/workspace-metadata-set'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import { getWorkspaceReferenceIdentity } from '../../../../../../shared/workspace-attachments/workspace-reference-identity'
import type { AppState } from '../../../types'
import { worktreeHostMatchOptions, worktreeMatchesHost } from './worktree-host-ownership'
import { selectWorktreesByRepo } from '../../../workspaces/catalog/workspace-record-fields'

/** Where a record came from: this app's own main, or a paired host's runtime event stream. */
export type MetadataSetSource = { kind: 'local' } | { kind: 'environment'; environmentId: string }

type PendingTitles = {
  repoId: string
  match: (row: Worktree) => boolean
  titles: Map<string, string>
  until: number
}
// One producer stream within one epoch; a new epoch drops the table.
type ProducerStream = {
  epoch: string
  seqById: Map<string, number>
  // Titles a listing that read metadata before the producer's write could still drop, for a while.
  pendingTitles: Map<string, PendingTitles>
}

const MAX_PENDING_TITLES = 500
// Longer than a listing round trip, so a listing begun before the write has landed by then.
const PENDING_TITLE_MS = 60_000
const streams = new Map<string, ProducerStream>()

function streamFor(key: string, epoch: string): ProducerStream {
  const current = streams.get(key)
  if (current?.epoch === epoch) {
    return current
  }
  const fresh = { epoch, seqById: new Map(), pendingTitles: new Map() }
  streams.set(key, fresh)
  return fresh
}

// The row a record names, by its own execution host; a paired host's SSH twin is a different row.
function rowMatcher(
  state: AppState,
  set: WorkspaceMetadataSet,
  source: MetadataSetSource
): (row: Worktree) => boolean {
  if (source.kind === 'local') {
    const options = worktreeHostMatchOptions(state, set.repoId, set.hostId)
    return (row) => row.id === set.worktreeId && worktreeMatchesHost(row, set.hostId, options)
  }
  const environmentHost = toRuntimeExecutionHostId(source.environmentId)
  const options = worktreeHostMatchOptions(state, set.repoId, environmentHost)
  const sshHost = parseExecutionHostId(set.hostId)?.kind === 'ssh' ? set.hostId : null
  return (row) =>
    row.id === set.worktreeId &&
    worktreeMatchesHost(row, environmentHost, options) &&
    (sshHost ? row.hostId === sshHost : parseExecutionHostId(row.hostId ?? null)?.kind !== 'ssh')
}

// Fills recorded titles into the row's still-untitled links; never adds, removes or retitles a link.
function fillTitles(
  state: AppState,
  pending: Pick<PendingTitles, 'repoId' | 'match' | 'titles'>
): { next: Pick<AppState, 'worktreesByRepo'> | null; linkGone: boolean } {
  const rows = selectWorktreesByRepo(state)[pending.repoId]
  const index = rows?.findIndex(pending.match) ?? -1
  if (!rows || index === -1) {
    return { next: null, linkGone: false }
  }
  const items = getWorkspaceAttachments(rows[index])
  if (!items.some((item) => pending.titles.has(getWorkspaceReferenceIdentity(item)))) {
    return { next: null, linkGone: true }
  }
  let filled = false
  const linkedItems = items.map((item) => {
    const title = item.title?.trim()
      ? undefined
      : pending.titles.get(getWorkspaceReferenceIdentity(item))
    if (!title) {
      return item
    }
    filled = true
    return { ...item, title }
  })
  if (!filled) {
    return { next: null, linkGone: false }
  }
  const next = rows.slice()
  next[index] = { ...rows[index], linkedItems }
  return {
    next: { worktreesByRepo: { ...selectWorktreesByRepo(state), [pending.repoId]: next } },
    linkGone: false
  }
}

/**
 * Applies a producer's addressed `workspaceMetadata` record. The only producer today saves issue titles,
 * so the client fills those titles and never takes the record's links over the row's current ones.
 */
export function patchWorktreeMetadataSet(
  state: AppState,
  set: WorkspaceMetadataSet,
  source: MetadataSetSource
): Pick<AppState, 'worktreesByRepo'> | AppState {
  const streamKey =
    source.kind === 'local' ? set.hostId : `${source.environmentId}\u0000${set.hostId}`
  const stream = streamFor(streamKey, set.epoch)
  const last = stream.seqById.get(set.id)
  if (last !== undefined && set.seq <= last) {
    return state
  }
  stream.seqById.set(set.id, set.seq)
  const titles = new Map<string, string>()
  for (const item of set.row.linkedItems ?? []) {
    const title = item.title?.trim()
    if (item.provider === 'github' && item.type === 'issue' && title) {
      titles.set(getWorkspaceReferenceIdentity(item), title)
    }
  }
  if (titles.size === 0) {
    return state
  }
  const pending = {
    repoId: set.repoId,
    match: rowMatcher(state, set, source),
    titles,
    until: Date.now() + PENDING_TITLE_MS
  }
  const { next, linkGone } = fillTitles(state, pending)
  stream.pendingTitles.delete(set.id)
  if (!linkGone) {
    stream.pendingTitles.set(set.id, pending)
    if (stream.pendingTitles.size > MAX_PENDING_TITLES) {
      stream.pendingTitles.delete(stream.pendingTitles.keys().next().value ?? '')
    }
  }
  return next ?? state
}

export function hasPendingIssueTitles(): boolean {
  return [...streams.values()].some((stream) => stream.pendingTitles.size > 0)
}

/** After a listing lands, refills recorded titles into rows that still hold the same untitled link. */
export function reapplyPendingIssueTitles(
  state: AppState
): Pick<AppState, 'worktreesByRepo'> | AppState {
  const now = Date.now()
  let current = state
  let changed = false
  for (const stream of streams.values()) {
    for (const [id, pending] of stream.pendingTitles) {
      if (now > pending.until) {
        stream.pendingTitles.delete(id)
        continue
      }
      const { next, linkGone } = fillTitles(current, pending)
      if (linkGone) {
        // The link was removed after the record: never bring it back.
        stream.pendingTitles.delete(id)
      } else if (next) {
        current = { ...current, ...next }
        changed = true
      }
    }
  }
  return changed ? { worktreesByRepo: selectWorktreesByRepo(current) } : state
}
