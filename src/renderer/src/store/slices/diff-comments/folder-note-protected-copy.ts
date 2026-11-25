import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { peekHostCatalogGeneration } from '../../host-catalog/host-catalog-fence'
import { findOwnedFolder } from './diff-comment-owner'
import {
  catalogTargetOf,
  forgetFolderNotesFence,
  recordFolderNotesFence
} from './folder-note-fence'
import { projectFolderNoteVerdict } from './folder-note-receipt'
import {
  NOTHING_SATISFIED,
  overlayFolderNotes,
  ownedFolderRow,
  settleFolderNoteAction,
  type ConfirmedNote,
  type FolderNoteAction,
  type FolderOwner
} from './folder-note-actions'
import type { FolderDiffCommentVerdict } from '../../../../../shared/file-review/folder-diff-comment-merge'

export type Set = Parameters<StateCreator<AppState>>[0]
export type EnqueueFolderNoteRead = (task: () => Promise<void>) => void

/**
 * After a failed save the host may hold the failed change or not; until an acknowledged protected
 * write ends a burst, every write of this copy is one merge-only action delta, and what the copy
 * shows is derived: the last host-issued list, what the host confirmed since, then the unsettled
 * actions in call order. Bound to one row incarnation on one endpoint.
 */
export type ProtectedCopy = {
  key: string
  owner: FolderOwner
  createdAt: number | undefined
  pairingRevision: number | undefined
  enqueueRead: EnqueueFolderNoteRead
  failed: boolean
  lastRunAcknowledged: boolean
  // Undefined while idle: the next event takes the list state shows as a provisional base.
  authoritative: DiffComment[] | undefined
  // The display rests on an observation or floor, not on a host-issued list after the last write.
  provisional: boolean
  pending: FolderNoteAction[]
  // Per id, what an acknowledged receipt confirmed but no host-issued list has shown yet; one entry
  // per id, so it is bounded by the notes touched. Dropped by a host list or a later catalog fetch.
  confirmed: Map<string, ConfirmedNote>
  // The array this queue last put in state; anything else there came from outside (a refresh).
  shown: DiffComment[] | undefined
  observationGeneration: number
  dirty: boolean
  readAttempts: number
  readInFlight: boolean
  readToken: number
  actionSeq: number
  reportedNoSnapshot: boolean
}

// Why a bound: a host refusing every write must not grow an unbounded backlog of retained actions.
export const MAX_PENDING_FOLDER_NOTE_ACTIONS = 256

export const protectedCopies = new Map<string, ProtectedCopy>()

export function isCurrentCopy(copy: ProtectedCopy): boolean {
  return protectedCopies.get(copy.key) === copy
}

/** A host-issued list newer than everything this copy observed or had confirmed. */
export function adoptHostList(
  copy: ProtectedCopy,
  get: () => AppState,
  notes: DiffComment[]
): void {
  copy.authoritative = notes
  copy.confirmed.clear()
  copy.provisional = false
  copy.dirty = false
  recordFolderNotesFence(get, copy.owner)
}

/** Keeps what an acknowledged receipt says the host holds, projecting absence as absence. */
export function recordConfirmed(
  copy: ProtectedCopy,
  get: () => AppState,
  action: FolderNoteAction,
  verdict: FolderDiffCommentVerdict
): ReadonlySet<string> {
  const { satisfied, held } = projectFolderNoteVerdict(action, verdict)
  const generation = peekHostCatalogGeneration(get, 'folder-workspaces', catalogTargetOf(copy.owner))
  for (const [id, entry] of held) {
    const prior = copy.confirmed.get(id)
    copy.confirmed.delete(id)
    if (!entry.known) {
      // Another version won and this client has no copy of it: show the base until a host list.
      copy.dirty = true
      continue
    }
    const wasAbsent = prior ? prior.note === undefined || prior.relocated : action.before.get(id) === undefined
    copy.confirmed.set(id, { note: entry.note, relocated: !!entry.note && wasAbsent, generation })
  }
  return satisfied
}

/** The owned row is gone, recreated or served by another pairing: this copy's notes are not its. */
function isReplaced(copy: ProtectedCopy, get: () => AppState): boolean {
  const row = ownedFolderRow(get(), copy.owner)
  return (
    !row ||
    row.createdAt !== copy.createdAt ||
    (!!copy.owner.runtimeEnvironmentId &&
      getRuntimeEnvironmentRevision(copy.owner.runtimeEnvironmentId) !== copy.pairingRevision)
  )
}

/**
 * Ends this copy without showing anything more: unsent actions are refused, and the old row's
 * fence goes. A send already in flight still reports its own outcome.
 */
export function retireProtectedCopy(copy: ProtectedCopy, reason: string): void {
  if (!isCurrentCopy(copy)) {
    return
  }
  protectedCopies.delete(copy.key)
  forgetFolderNotesFence(copy.owner)
  for (const action of copy.pending) {
    if (!action.refusedUnsent && !sentActions.has(action)) {
      action.refusedUnsent = reason
      settleFolderNoteAction(copy.key, action, NOTHING_SATISFIED)
    }
  }
  copy.pending = []
  copy.confirmed.clear()
  copy.authoritative = undefined
}

// Actions whose request has left this computer; they settle by their own reply.
export const sentActions = new WeakSet<FolderNoteAction>()

/** False (and the copy retired) when the row it was bound to is no longer the one state shows. */
export function retireIfReplaced(copy: ProtectedCopy, get: () => AppState): boolean {
  if (!isCurrentCopy(copy)) {
    return false
  }
  if (isReplaced(copy, get)) {
    retireProtectedCopy(copy, 'host changed')
    return false
  }
  return true
}

/** Like retireIfReplaced, and a list in state the queue did not put there becomes the base. */
export function noticeOutsideReplacement(copy: ProtectedCopy, get: () => AppState): boolean {
  if (!retireIfReplaced(copy, get)) {
    return false
  }
  const current = findOwnedFolder(get(), copy.owner)?.diffComments
  if (current !== copy.shown || copy.authoritative === undefined) {
    observe(copy, current)
  }
  return true
}

export function observe(copy: ProtectedCopy, list: readonly DiffComment[] | undefined): void {
  copy.authoritative = [...(list ?? [])]
  copy.provisional = true
  copy.observationGeneration += 1
  copy.dirty = true
  copy.shown = list as DiffComment[] | undefined
}

export function displayOf(copy: ProtectedCopy, base: readonly DiffComment[]): DiffComment[] {
  return overlayFolderNotes(base, copy.confirmed, copy.pending)
}

/** Shows the derived list, unless something outside the queue replaced the copy's list first. */
export function publish(copy: ProtectedCopy, get: () => AppState, set: Set): void {
  if (!noticeOutsideReplacement(copy, get)) {
    return
  }
  const current = copy.shown
  const display = displayOf(copy, copy.authoritative ?? [])
  copy.shown = display
  set((state) => {
    const target = findOwnedFolder(state, copy.owner)
    if (!target || target.diffComments !== current) {
      return state
    }
    return {
      folderWorkspaces: state.folderWorkspaces.map((workspace) =>
        workspace === target ? { ...workspace, diffComments: display } : workspace
      )
    }
  })
}

export function settle(
  copy: ProtectedCopy,
  action: FolderNoteAction,
  satisfied: ReadonlySet<string>
): void {
  copy.pending = copy.pending.filter((entry) => entry !== action)
  sentActions.delete(action)
  settleFolderNoteAction(copy.key, action, satisfied)
}

/** At a quiet tail with nothing more to do: keep only what the next event needs. */
export function releaseIdleState(copy: ProtectedCopy): void {
  copy.authoritative = undefined
  copy.provisional = true
}

export function noteMissingSnapshot(copy: ProtectedCopy): void {
  if (!copy.reportedNoSnapshot) {
    copy.reportedNoSnapshot = true
    console.warn('Review notes: the host could not return the full note list; showing local notes.')
  }
}
