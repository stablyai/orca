import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import { findOwnedFolder } from './diff-comment-owner'
import { recordFolderNotesFence } from './folder-note-fence'
import {
  overlayFolderNotes,
  settleFolderNoteAction,
  type FolderNoteAction,
  type FolderOwner
} from './folder-note-actions'

export type Set = Parameters<StateCreator<AppState>>[0]
export type EnqueueFolderNoteRead = (task: () => Promise<void>) => void

/**
 * After a failed save the host may hold the failed change or not; until an acknowledged protected
 * write ends a burst, every write of this copy is one merge-only action delta, and what the copy
 * shows is derived: the last host-issued list plus the unsettled actions in call order.
 */
export type ProtectedCopy = {
  owner: FolderOwner
  enqueueRead: EnqueueFolderNoteRead
  failed: boolean
  lastRunAcknowledged: boolean
  authoritative: DiffComment[]
  // The display rests on an observation or floor, not on a host-issued list after the last write.
  provisional: boolean
  pending: FolderNoteAction[]
  // Saved actions whose receipt could not become the base (a newer observation): still shown
  // until a host-issued list replaces the base, so a saved note never blinks out meanwhile.
  acknowledged: FolderNoteAction[]
  // The array this queue last put in state; anything else there came from outside (a refresh).
  shown: DiffComment[] | undefined
  observationGeneration: number
  dirty: boolean
  readAttempts: number
  readInFlight: boolean
  actionSeq: number
  // The receiver has no merge method: automatic reads are skipped until a write gets through.
  mergeUnsupported: boolean
  reportedNoSnapshot: boolean
}

// Why a bound: a host refusing every write must not grow an unbounded backlog of retained actions.
export const MAX_PENDING_FOLDER_NOTE_ACTIONS = 256

export const protectedCopies = new Map<string, ProtectedCopy>()

/** A host-issued list newer than everything this copy observed or had acknowledged. */
export function adoptHostList(
  copy: ProtectedCopy,
  get: () => AppState,
  notes: DiffComment[]
): void {
  copy.authoritative = notes
  copy.acknowledged = []
  copy.provisional = false
  copy.dirty = false
  recordFolderNotesFence(get, copy.owner)
}

export function noticeOutsideReplacement(copy: ProtectedCopy, get: () => AppState): void {
  const current = findOwnedFolder(get(), copy.owner)?.diffComments
  if (current !== copy.shown) {
    observe(copy, current)
  }
}

export function observe(copy: ProtectedCopy, list: readonly DiffComment[] | undefined): void {
  copy.authoritative = [...(list ?? [])]
  copy.provisional = true
  copy.observationGeneration += 1
  copy.dirty = true
  copy.shown = list as DiffComment[] | undefined
}

/** Shows the derived list, unless something outside the queue replaced the copy's list first. */
export function publish(copy: ProtectedCopy, get: () => AppState, set: Set): void {
  noticeOutsideReplacement(copy, get)
  const current = copy.shown
  const display = overlayFolderNotes(copy.authoritative, [...copy.acknowledged, ...copy.pending])
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
  copyKey: string,
  copy: ProtectedCopy,
  action: FolderNoteAction,
  saved: boolean
): void {
  copy.pending = copy.pending.filter((entry) => entry !== action)
  settleFolderNoteAction(copyKey, action, saved)
}

export function noteMissingSnapshot(copy: ProtectedCopy): void {
  if (!copy.reportedNoSnapshot) {
    copy.reportedNoSnapshot = true
    console.warn('Review notes: the host could not return the full note list; showing local notes.')
  }
}
