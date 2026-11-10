import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorkspaceMetadataSet } from '../../../../../../shared/worktree/workspace-metadata-set'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import { getWorkspaceReferenceIdentity } from '../../../../../../shared/workspace-attachments/workspace-reference-identity'
import type { AppState } from '../../../types'
import { worktreeHostMatchOptions, worktreeMatchesHost } from './worktree-host-ownership'
import { selectWorktreesByRepo } from '../../../workspaces/catalog/workspace-record-fields'

type PendingTitles = {
  repoId: string
  worktreeId: string
  titles: Map<string, string>
  until: number
}
// One producer stream (the client's host id for it) within one epoch; a new epoch drops the table.
type ProducerStream = {
  epoch: string
  seqById: Map<string, number>
  // Issue titles a listing that read metadata before the producer's write could still drop, for a while.
  pendingTitles: Map<string, PendingTitles>
}

const MAX_PENDING_TITLES = 500
// Longer than a listing round trip, so a listing begun before the write has landed by then.
const PENDING_TITLE_MS = 60_000
const streams = new Map<ExecutionHostId, ProducerStream>()

function streamFor(hostId: ExecutionHostId, epoch: string): ProducerStream {
  const current = streams.get(hostId)
  if (current?.epoch === epoch) {
    return current
  }
  const fresh = { epoch, seqById: new Map(), pendingTitles: new Map() }
  streams.set(hostId, fresh)
  return fresh
}

function rowIndex(state: AppState, repoId: string, worktreeId: string, hostId: ExecutionHostId) {
  const rows = selectWorktreesByRepo(state)[repoId]
  const matchOptions = worktreeHostMatchOptions(state, repoId, hostId)
  const index =
    rows?.findIndex(
      (worktree) =>
        worktree.id === worktreeId && worktreeMatchesHost(worktree, hostId, matchOptions)
    ) ?? -1
  return { rows, index }
}

function withRow(
  state: AppState,
  repoId: string,
  rows: readonly Worktree[],
  index: number,
  row: Worktree
): Pick<AppState, 'worktreesByRepo'> {
  const next = rows.slice()
  next[index] = row
  return { worktreesByRepo: { ...selectWorktreesByRepo(state), [repoId]: next } }
}

/** Applies one producer's addressed `workspaceMetadata` set record to the row it names. */
export function patchWorktreeMetadataSet(
  state: AppState,
  set: WorkspaceMetadataSet,
  // The client's own id for the producing host (a paired server's records arrive as its local rows).
  hostId: ExecutionHostId
): Pick<AppState, 'worktreesByRepo'> | AppState {
  const stream = streamFor(hostId, set.epoch)
  const last = stream.seqById.get(set.id)
  if (last !== undefined && set.seq <= last) {
    return state
  }
  stream.seqById.set(set.id, set.seq)
  const titles = new Map(
    (set.row.linkedItems ?? [])
      .filter((item) => item.provider === 'github' && item.type === 'issue' && item.title?.trim())
      .map((item) => [getWorkspaceReferenceIdentity(item), item.title ?? ''])
  )
  if (titles.size > 0) {
    stream.pendingTitles.delete(set.id)
    stream.pendingTitles.set(set.id, {
      repoId: set.repoId,
      worktreeId: set.worktreeId,
      titles,
      until: Date.now() + PENDING_TITLE_MS
    })
    if (stream.pendingTitles.size > MAX_PENDING_TITLES) {
      stream.pendingTitles.delete(stream.pendingTitles.keys().next().value ?? '')
    }
  }
  const { rows, index } = rowIndex(state, set.repoId, set.worktreeId, hostId)
  return rows && index !== -1
    ? withRow(state, set.repoId, rows, index, { ...rows[index], ...set.row })
    : state
}

export function hasPendingIssueTitles(): boolean {
  return [...streams.values()].some((stream) => stream.pendingTitles.size > 0)
}

/**
 * After a listing lands, fills recorded titles into rows that still hold the same untitled link: a listing
 * that read metadata before the producer's write must not drop the title. Never adds or restores a link.
 */
export function reapplyPendingIssueTitles(
  state: AppState
): Pick<AppState, 'worktreesByRepo'> | AppState {
  const now = Date.now()
  let next: AppState = state
  let changed = false
  for (const [hostId, stream] of streams) {
    for (const [id, pending] of stream.pendingTitles) {
      if (now > pending.until) {
        stream.pendingTitles.delete(id)
        continue
      }
      const { rows, index } = rowIndex(next, pending.repoId, pending.worktreeId, hostId)
      if (!rows || index === -1) {
        continue
      }
      const row = rows[index]
      const items = getWorkspaceAttachments(row)
      if (!items.some((item) => pending.titles.has(getWorkspaceReferenceIdentity(item)))) {
        // The link was removed after the record: never bring it back.
        stream.pendingTitles.delete(id)
        continue
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
      if (filled) {
        next = { ...next, ...withRow(next, pending.repoId, rows, index, { ...row, linkedItems }) }
        changed = true
      }
    }
  }
  return changed ? { worktreesByRepo: selectWorktreesByRepo(next) } : state
}
