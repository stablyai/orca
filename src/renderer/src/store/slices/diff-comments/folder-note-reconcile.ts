import type { AppState } from '../../types'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { findOwnedFolder } from './diff-comment-owner'
import { isUnsupportedFolderNoteMerge, mergeFolderDiffComments } from './folder-note-merge-call'
import {
  folderCatalogHostIdOf,
  folderWorkspaceIdOf,
  isFolderNotesFenceHolding
} from './folder-note-fence'
import { nextFolderNoteSeq, ownedFolderRow } from './folder-note-actions'
import { checkFolderNoteReceipt, folderNoteRequest } from './folder-note-receipt'
import {
  adoptHostList,
  noteMissingSnapshot,
  observe,
  protectedCopies,
  publish,
  type ProtectedCopy,
  type Set
} from './folder-note-protected-copy'

/** At a quiet tail: end protection, or reconcile the display with one keyed read. */
export function afterSettle(
  copyKey: string,
  copy: ProtectedCopy,
  get: () => AppState,
  set: Set
): void {
  if (copy.pending.length > 0 || copy.readInFlight) {
    return
  }
  if (copy.lastRunAcknowledged) {
    copy.failed = false
  }
  if (!copy.dirty && !copy.provisional) {
    if (!copy.failed) {
      protectedCopies.delete(copyKey)
    }
    return
  }
  // One read per quiet tail, plus one follow-up after a genuine invalidation; churn waits for a real event.
  if (copy.readAttempts >= 2 || copy.mergeUnsupported) {
    return
  }
  copy.readAttempts += 1
  copy.readInFlight = true
  copy.enqueueRead(() => reconcile(copyKey, copy, get, set))
}

async function reconcile(
  copyKey: string,
  copy: ProtectedCopy,
  get: () => AppState,
  set: Set
): Promise<void> {
  const expectedCreatedAt = ownedFolderRow(get(), copy.owner)?.createdAt
  if (protectedCopies.get(copyKey) !== copy || expectedCreatedAt === undefined) {
    copy.readInFlight = false
    return
  }
  const startedAt = { generation: copy.observationGeneration, actions: copy.actionSeq }
  const request = folderNoteRequest(
    copy.owner,
    { seq: nextFolderNoteSeq(), delta: new Map(), before: new Map() },
    'read',
    expectedCreatedAt
  )
  let reply: unknown
  try {
    reply = await mergeFolderDiffComments(copy.owner, request, { passive: true })
  } catch (err) {
    // Unreadable: the display stays provisional and protection armed until a real refresh or action.
    copy.mergeUnsupported = isUnsupportedFolderNoteMerge(err)
    copy.readInFlight = false
    return
  }
  copy.readInFlight = false
  const receipt = checkFolderNoteReceipt(reply, request)
  if (!receipt) {
    return
  }
  if (!receipt.snapshot) {
    noteMissingSnapshot(copy)
    return
  }
  const current = ownedFolderRow(get(), copy.owner)
  const stillQuiet =
    protectedCopies.get(copyKey) === copy &&
    copy.pending.length === 0 &&
    copy.actionSeq === startedAt.actions &&
    copy.observationGeneration === startedAt.generation &&
    current?.createdAt === expectedCreatedAt &&
    current?.diffComments === copy.shown
  if (!stillQuiet) {
    // Invalidated by a newer action or observation: one fresh read at the next quiet tail.
    if (current && current.diffComments !== copy.shown) {
      observe(copy, current.diffComments)
    }
    afterSettle(copyKey, copy, get, set)
    return
  }
  adoptHostList(copy, get, receipt.snapshot)
  copy.readAttempts = 0
  publish(copy, get, set)
  // A read cannot clear a failed tail; only an acknowledged write ends protection.
  afterSettle(copyKey, copy, get, set)
}

/**
 * A folder catalog fetch (not held back by the fence) carrying a protected copy's row, equal-valued
 * or not: an observation newer than anything in flight. Returns the copies to show again.
 */
export function observeFolderCatalogInput(args: {
  catalogHostId: ExecutionHostId
  fetchGeneration: number
  merged: readonly FolderWorkspace[]
  rowHostId: (row: FolderWorkspace) => ExecutionHostId
}): string[] {
  if (protectedCopies.size === 0) {
    return []
  }
  const observed: string[] = []
  for (const [copyKey, copy] of protectedCopies) {
    const folderWorkspaceId = folderWorkspaceIdOf(copy.owner)
    if (
      !folderWorkspaceId ||
      folderCatalogHostIdOf(copy.owner) !== args.catalogHostId ||
      isFolderNotesFenceHolding(copy.owner.executionHostId, folderWorkspaceId, args.fetchGeneration)
    ) {
      continue
    }
    const row = args.merged.find(
      (entry) =>
        entry.id === folderWorkspaceId && args.rowHostId(entry) === copy.owner.executionHostId
    )
    const overlapping = copy.pending.length > 0 || copy.readInFlight
    const unreconciled = copy.dirty || copy.provisional
    copy.authoritative = [...(row?.diffComments ?? [])]
    copy.observationGeneration += 1
    if (overlapping || unreconciled) {
      copy.provisional = true
      copy.dirty = true
    }
    // A genuine refresh of a quiet, unreconciled copy earns one more read (recovery after a failed one).
    if (!overlapping && unreconciled) {
      copy.readAttempts = 0
    }
    observed.push(copyKey)
  }
  return observed
}

/** After the catalog landed in state: show each observed copy and reconcile a quiet one. */
export function afterFolderCatalogObserved(
  copyKeys: readonly string[],
  get: () => AppState,
  set: Set
): void {
  for (const copyKey of copyKeys) {
    const copy = protectedCopies.get(copyKey)
    if (!copy) {
      continue
    }
    copy.shown = findOwnedFolder(get(), copy.owner)?.diffComments
    if (copy.pending.length > 0) {
      publish(copy, get, set)
    }
    afterSettle(copyKey, copy, get, set)
  }
}
