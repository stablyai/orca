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

/**
 * Where a record came from: this app's own main, or a paired host's runtime event stream. `isCurrent`
 * stays true only while that pairing and connection are the ones the record arrived on.
 */
export type MetadataSetSource =
  | { kind: 'local' }
  | { kind: 'environment'; environmentId: string; isCurrent: () => boolean }

type PendingTitles = {
  streamKey: string
  // The record's seq: a replayed or older record for the same workspace is dropped while this lives.
  seq: number
  worktreeId: string
  match: (row: Worktree) => boolean
  titles: Map<string, string>
  until: number
  // The row object last checked; an unchanged row needs no second look.
  checkedRow: Worktree | null
  // False once the producer's pairing or connection was replaced: its titles no longer apply.
  isCurrent: () => boolean
}

const MAX_PENDING_TITLES = 500
// Longer than a listing round trip, so a listing begun before the write has landed by then.
const PENDING_TITLE_MS = 60_000
// Titles a listing that read metadata before the producer's write could still drop, for a while,
// by repo; a producer's new epoch drops its entries.
const pendingByRepo = new Map<string, Map<string, PendingTitles>>()
const epochByStream = new Map<string, string>()
let pendingCount = 0

function deletePending(repoId: string, key: string): void {
  const entries = pendingByRepo.get(repoId)
  if (entries?.delete(key)) {
    pendingCount--
    if (entries.size === 0) {
      pendingByRepo.delete(repoId)
    }
  }
}

function prunePending(keep: (entry: PendingTitles) => boolean): void {
  for (const [repoId, entries] of pendingByRepo) {
    for (const [key, entry] of entries) {
      if (!keep(entry)) {
        deletePending(repoId, key)
      }
    }
  }
}

// The row a record names, by its own execution host; a paired host's SSH twin is a different row.
function rowMatcher(
  state: AppState,
  set: WorkspaceMetadataSet,
  source: MetadataSetSource
): (row: Worktree) => boolean {
  if (source.kind === 'local') {
    const options = worktreeHostMatchOptions(state, set.repoId, set.hostId)
    return (row) => worktreeMatchesHost(row, set.hostId, options)
  }
  const environmentHost = toRuntimeExecutionHostId(source.environmentId)
  const options = worktreeHostMatchOptions(state, set.repoId, environmentHost)
  const sshHost = parseExecutionHostId(set.hostId)?.kind === 'ssh' ? set.hostId : null
  return (row) =>
    worktreeMatchesHost(row, environmentHost, options) &&
    (sshHost ? row.hostId === sshHost : parseExecutionHostId(row.hostId ?? null)?.kind !== 'ssh')
}

// The recorded titles filled into the row's still-untitled links, or null when nothing changes.
// Never adds, removes or retitles a link.
function withTitles(row: Worktree, titles: Map<string, string>): Worktree | null {
  let filled = false
  const linkedItems = getWorkspaceAttachments(row).map((item) => {
    const title = item.title?.trim() ? undefined : titles.get(getWorkspaceReferenceIdentity(item))
    if (!title) {
      return item
    }
    filled = true
    return { ...item, title }
  })
  return filled ? { ...row, linkedItems } : null
}

// Checks one repo's pending titles against its rows: O(rows + pending), skipping rows already checked.
function fillRepo(
  state: AppState,
  repoId: string,
  now: number
): Pick<AppState, 'worktreesByRepo'> | null {
  const entries = pendingByRepo.get(repoId)
  const rows = selectWorktreesByRepo(state)[repoId]
  if (!entries || !rows) {
    return null
  }
  const indexesById = new Map<string, number[]>()
  rows.forEach((row, index) => {
    const indexes = indexesById.get(row.id)
    if (indexes) {
      indexes.push(index)
    } else {
      indexesById.set(row.id, [index])
    }
  })
  let next: Worktree[] | null = null
  for (const [key, entry] of entries) {
    if (now > entry.until || !entry.isCurrent()) {
      deletePending(repoId, key)
      continue
    }
    const index = (indexesById.get(entry.worktreeId) ?? []).find((i) => entry.match(rows[i]))
    const row = index === undefined ? undefined : (next ?? rows)[index]
    if (index === undefined || !row || row === entry.checkedRow) {
      continue
    }
    const filled = withTitles(row, entry.titles)
    entry.checkedRow = filled ?? row
    if (filled) {
      next ??= rows.slice()
      next[index] = filled
    }
  }
  return next ? { worktreesByRepo: { ...selectWorktreesByRepo(state), [repoId]: next } } : null
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
  if (epochByStream.get(streamKey) !== set.epoch) {
    epochByStream.set(streamKey, set.epoch)
    prunePending((entry) => entry.streamKey !== streamKey)
  }
  const key = `${streamKey}\u0000${set.id}`
  const existing = pendingByRepo.get(set.repoId)?.get(key)
  if (existing && set.seq <= existing.seq) {
    return state
  }
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
  const now = Date.now()
  if (pendingCount >= MAX_PENDING_TITLES) {
    prunePending((entry) => now <= entry.until && entry.isCurrent())
  }
  deletePending(set.repoId, key)
  if (pendingCount >= MAX_PENDING_TITLES) {
    const [oldestRepo, oldestEntries] = pendingByRepo.entries().next().value ?? []
    const oldestKey = oldestEntries?.keys().next().value
    if (oldestRepo && oldestKey) {
      deletePending(oldestRepo, oldestKey)
    }
  }
  // Kept until it expires: the row may list the link only after this record, and filling only
  // present untitled links means a removed link is never brought back.
  const entries = pendingByRepo.get(set.repoId) ?? new Map<string, PendingTitles>()
  pendingByRepo.set(set.repoId, entries)
  entries.set(key, {
    streamKey,
    seq: set.seq,
    worktreeId: set.worktreeId,
    match: rowMatcher(state, set, source),
    titles,
    until: now + PENDING_TITLE_MS,
    checkedRow: null,
    isCurrent: source.kind === 'environment' ? source.isCurrent : () => true
  })
  pendingCount++
  return fillRepo(state, set.repoId, now) ?? state
}

export function hasPendingIssueTitles(): boolean {
  return pendingCount > 0
}

/** After a listing lands, refills recorded titles into rows that still hold the same untitled link. */
export function reapplyPendingIssueTitles(
  state: AppState,
  previous: AppState
): Pick<AppState, 'worktreesByRepo'> | AppState {
  const now = Date.now()
  let current = state
  let changed = false
  for (const repoId of pendingByRepo.keys()) {
    // Only a repo whose listing changed can have lost a title.
    if (selectWorktreesByRepo(state)[repoId] === selectWorktreesByRepo(previous)[repoId]) {
      continue
    }
    const next = fillRepo(current, repoId, now)
    if (next) {
      current = { ...current, ...next }
      changed = true
    }
  }
  return changed ? { worktreesByRepo: selectWorktreesByRepo(current) } : state
}
