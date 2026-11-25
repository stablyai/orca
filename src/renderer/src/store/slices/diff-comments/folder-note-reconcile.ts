import type { AppState } from '../../types'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { findOwnedFolder } from './diff-comment-owner'
import { mergeFolderDiffComments } from './folder-note-merge-call'
import {
  folderCatalogHostIdOf,
  folderWorkspaceIdOf,
  isFolderNotesFenceHolding
} from './folder-note-fence'
import { nextFolderNoteSeq, ownedFolderRow } from './folder-note-actions'
import { checkFolderNoteReceipt, folderNoteRequest } from './folder-note-receipt'
import {
  adoptHostList,
  displayOf,
  isCurrentCopy,
  noteMissingSnapshot,
  observe,
  protectedCopies,
  publish,
  releaseIdleState,
  retireProtectedCopy,
  type ProtectedCopy,
  type Set
} from './folder-note-protected-copy'

// Why a bound: a stalled read must never hold the writes queued behind it.
export const FOLDER_NOTE_READ_TIMEOUT_MS = 15_000

/**
 * At a quiet tail: end protection, or reconcile the display with one keyed read. Only local copies
 * read on their own: a paired route's preparation can rebuild an SSH tunnel or restart a stopped
 * server, which a read nobody asked for must never do. A paired copy reconciles on its next
 * acknowledged write or catalog fetch instead.
 */
export function afterSettle(copy: ProtectedCopy, get: () => AppState, set: Set): void {
  if (copy.pending.length > 0 || copy.readInFlight || !isCurrentCopy(copy)) {
    return
  }
  if (copy.lastRunAcknowledged) {
    copy.failed = false
  }
  if (!copy.dirty && !copy.provisional) {
    if (copy.failed) {
      releaseIdleState(copy)
    } else {
      protectedCopies.delete(copy.key)
    }
    return
  }
  // One read per quiet tail, plus one follow-up after a genuine invalidation; churn waits for a real event.
  if (copy.owner.runtimeEnvironmentId || copy.readAttempts >= 2) {
    releaseIdleState(copy)
    return
  }
  copy.readAttempts += 1
  copy.readInFlight = true
  copy.enqueueRead(() => reconcile(copy, get, set))
}

async function readWithinBound(
  copy: ProtectedCopy,
  request: ReturnType<typeof folderNoteRequest>
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('read timed out')), FOLDER_NOTE_READ_TIMEOUT_MS)
  })
  try {
    // A late answer after the bound is simply never looked at.
    return await Promise.race([mergeFolderDiffComments(copy.owner, request), timedOut])
  } finally {
    clearTimeout(timer)
  }
}

async function reconcile(copy: ProtectedCopy, get: () => AppState, set: Set): Promise<void> {
  const expectedCreatedAt = ownedFolderRow(get(), copy.owner)?.createdAt
  copy.readInFlight = false
  if (!isCurrentCopy(copy)) {
    return
  }
  if (expectedCreatedAt === undefined || expectedCreatedAt !== copy.createdAt) {
    retireProtectedCopy(copy, 'host changed')
    return
  }
  copy.readInFlight = true
  const startedAt = { generation: copy.observationGeneration, actions: copy.actionSeq }
  const request = folderNoteRequest(
    copy.owner,
    { seq: nextFolderNoteSeq(), delta: new Map(), before: new Map() },
    'read',
    expectedCreatedAt
  )
  let reply: unknown
  try {
    reply = await readWithinBound(copy, request)
  } catch {
    reply = undefined
  }
  copy.readInFlight = false
  const receipt = checkFolderNoteReceipt(reply, request)
  if (!receipt?.snapshot) {
    if (receipt) {
      noteMissingSnapshot(copy)
    }
    // Unreadable: the display stays provisional and protection armed until a real refresh or action;
    // one that already arrived during this read earns its follow-up now.
    if (copy.observationGeneration === startedAt.generation) {
      copy.readAttempts = 2
    }
    afterSettle(copy, get, set)
    return
  }
  const current = ownedFolderRow(get(), copy.owner)
  const stillQuiet =
    isCurrentCopy(copy) &&
    copy.pending.length === 0 &&
    copy.actionSeq === startedAt.actions &&
    copy.observationGeneration === startedAt.generation &&
    current?.createdAt === expectedCreatedAt &&
    current?.diffComments === copy.shown
  if (!stillQuiet) {
    // Invalidated by a newer action or observation: one fresh read at the next quiet tail.
    if (current && current.diffComments !== copy.shown && isCurrentCopy(copy)) {
      observe(copy, current.diffComments)
    }
    afterSettle(copy, get, set)
    return
  }
  adoptHostList(copy, get, receipt.snapshot)
  copy.readAttempts = 0
  publish(copy, get, set)
  // A read cannot clear a failed tail; only an acknowledged write ends protection.
  afterSettle(copy, get, set)
}

function sameElements(a: readonly unknown[], b: readonly unknown[] | undefined): boolean {
  return !!b && a.length === b.length && a.every((entry, index) => entry === b[index])
}

/**
 * A folder catalog fetch (not held back by the fence) carrying a protected copy's row, equal-valued
 * or not: an observation newer than anything in flight. Returns the rows to commit, with each
 * copy's confirmed and pending notes already applied, so no subscriber ever sees the bare fetch;
 * and the copies to reconcile after the commit. A row that is gone, recreated or re-paired retires
 * its copy instead.
 */
export function observeFolderCatalogInput(args: {
  catalogHostId: ExecutionHostId
  fetchGeneration: number
  merged: readonly FolderWorkspace[]
  rowHostId: (row: FolderWorkspace) => ExecutionHostId
}): { observed: ProtectedCopy[]; merged: readonly FolderWorkspace[] } {
  if (protectedCopies.size === 0) {
    return { observed: [], merged: args.merged }
  }
  const observed: ProtectedCopy[] = []
  let merged = args.merged
  for (const copy of protectedCopies.values()) {
    const folderWorkspaceId = folderWorkspaceIdOf(copy.owner)
    if (
      !folderWorkspaceId ||
      folderCatalogHostIdOf(copy.owner) !== args.catalogHostId ||
      isFolderNotesFenceHolding(copy.owner.executionHostId, folderWorkspaceId, args.fetchGeneration)
    ) {
      continue
    }
    const index = merged.findIndex(
      (entry) =>
        entry.id === folderWorkspaceId && args.rowHostId(entry) === copy.owner.executionHostId
    )
    const row = index === -1 ? undefined : merged[index]
    if (
      !row ||
      row.createdAt !== copy.createdAt ||
      (!!copy.owner.runtimeEnvironmentId &&
        getRuntimeEnvironmentRevision(copy.owner.runtimeEnvironmentId) !== copy.pairingRevision)
    ) {
      retireProtectedCopy(copy, 'host changed')
      continue
    }
    // A fetch claimed after a confirmation sampled the host after it: the row itself says it now.
    for (const [id, entry] of copy.confirmed) {
      if (args.fetchGeneration > entry.generation) {
        copy.confirmed.delete(id)
      }
    }
    const overlapping = copy.pending.length > 0 || copy.readInFlight
    const unreconciled = copy.dirty || copy.provisional
    copy.authoritative = [...(row.diffComments ?? [])]
    copy.observationGeneration += 1
    if (overlapping || unreconciled) {
      copy.provisional = true
      copy.dirty = true
    }
    // A genuine refresh of a quiet, unreconciled copy earns one more read (recovery after a failed one).
    if (!overlapping && unreconciled) {
      copy.readAttempts = 0
    }
    const display = displayOf(copy, copy.authoritative)
    if (!sameElements(display, row.diffComments ?? [])) {
      const next = [...merged]
      next[index] = { ...row, diffComments: display }
      merged = next
    }
    observed.push(copy)
  }
  return { observed, merged }
}

/** After the catalog landed in state: record what each observed copy shows, then reconcile it. */
export function afterFolderCatalogObserved(
  copies: readonly ProtectedCopy[],
  get: () => AppState,
  set: Set
): void {
  for (const copy of copies) {
    if (!isCurrentCopy(copy)) {
      continue
    }
    copy.shown = findOwnedFolder(get(), copy.owner)?.diffComments
    afterSettle(copy, get, set)
  }
}
