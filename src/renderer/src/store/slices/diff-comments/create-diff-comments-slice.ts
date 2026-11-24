import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import {
  matchesDeliveredDiffComment,
  type DiffCommentDeliverySnapshot
} from '../../../../../shared/file-review/diff-comment-mutation'
import {
  diffCommentSendKey,
  holdNotesForSend
} from '@/components/notes/delivery/notes-send-in-flight'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import {
  enqueueDiffCommentPersist,
  mutateDiffComments,
  normalizeDiffComment
} from './diff-comment-persistence'
import { enqueueDeliveredDiffCommentCleanup } from './diff-comment-delivery-cleanup'
import { selectWorktreeDiffCommentsOrEmpty } from './worktree-diff-comments-selector'
import { showClearNotesFailedToast } from './clear-notes-failed-toast'
import {
  dismissSentNotesStillListedToast,
  showSentNotesStillListedToast
} from './sent-notes-still-listed-toast'
import { readOwnedDiffComments, type DiffCommentOwner } from './diff-comment-owner'

export type DiffCommentsSlice = {
  getDiffComments: (worktreeId: string | null | undefined) => DiffComment[]
  addDiffComment: (
    owner: DiffCommentOwner,
    input: Omit<DiffComment, 'id' | 'createdAt'>
  ) => Promise<DiffComment | null>
  updateDiffComment: (owner: DiffCommentOwner, commentId: string, body: string) => Promise<boolean>
  clearDeliveredDiffComments: (
    owner: DiffCommentOwner,
    comments: readonly DiffCommentDeliverySnapshot[]
  ) => Promise<boolean>
  markDiffCommentsSent: (
    owner: DiffCommentOwner,
    commentIds: readonly string[],
    sentAt?: number
  ) => Promise<boolean>
  deleteDiffComment: (owner: DiffCommentOwner, commentId: string) => Promise<void>
  /** Removes the listed notes that still exist; notes added since the list was taken stay. */
  deleteDiffCommentsByIds: (
    owner: DiffCommentOwner,
    commentIds: readonly string[]
  ) => Promise<boolean>
}

export type { DiffCommentDeliverySnapshot } from '../../../../../shared/file-review/diff-comment-mutation'

// Exact snapshots whose host removal is queued or running, so a repeated success report adds no second command.
const cleanupsInFlight = new Set<string>()

function markDeliveredDiffCommentsSent(
  set: Parameters<StateCreator<AppState>>[0],
  get: () => AppState,
  owner: DiffCommentOwner,
  snapshots: readonly DiffCommentDeliverySnapshot[]
): void {
  const sentAt = Date.now()
  const mutation = mutateDiffComments(set, owner, (existing) => {
    let changed = false
    const next = existing.map((note) => {
      // Only the delivered revision: a note edited since keeps its new text sendable.
      if (
        note.sentAt ||
        !snapshots.some((snapshot) => matchesDeliveredDiffComment(note, snapshot))
      ) {
        return note
      }
      changed = true
      return { ...note, sentAt }
    })
    return changed ? next : null
  })
  if (mutation) {
    enqueueDiffCommentPersist(set, owner.worktreeId, get, mutation).catch((err: unknown) => {
      console.error('Failed to persist diff comments:', err)
    })
  }
}

// Why: best-effort telemetry runs only after the note is on disk, so a throw here must not report a failed save.
function recordReviewNoteInteraction(get: () => AppState): void {
  try {
    get().recordFeatureInteraction?.('review-notes')
  } catch (err) {
    console.error('Failed to record review-notes interaction:', err)
  }
}

// Why: a copy gone since the user acted fails once, never on another copy. Add and clear callers already report their failures.
function reportLostDiffCommentOwner(action: 'save' | 'clear'): void {
  console.error('Review notes were not changed: the workspace copy they belong to is gone.')
  if (action === 'clear') {
    showClearNotesFailedToast()
    return
  }
  toast.error(translate('auto.components.editor.diffCommentSaveFailed', 'Failed to save comment'))
}

export const createDiffCommentsSlice: StateCreator<AppState, [], [], DiffCommentsSlice> = (
  set,
  get
) => ({
  // Why the shared selector: rendered surfaces and actions must read the same twin's notes.
  getDiffComments: (worktreeId) => selectWorktreeDiffCommentsOrEmpty(get(), worktreeId),

  addDiffComment: async (owner, input) => {
    if (!readOwnedDiffComments(get(), owner) || owner.worktreeId !== input.worktreeId) {
      return null
    }
    const comment: DiffComment = normalizeDiffComment({
      ...input,
      id: createNonSecureContextUuid(),
      createdAt: Date.now()
    })
    const result = mutateDiffComments(set, owner, (existing) => [...existing, comment])
    if (!result) {
      return null
    }
    try {
      // Why: serialize through the per-worktree queue so concurrent writes can't land on disk out of call order.
      await enqueueDiffCommentPersist(set, input.worktreeId, get, result)
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      return null
    }
    recordReviewNoteInteraction(get)
    return comment
  },

  updateDiffComment: async (owner, commentId, body) => {
    if (!readOwnedDiffComments(get(), owner)) {
      reportLostDiffCommentOwner('save')
      return false
    }
    const worktreeId = owner.worktreeId
    // Why: reject an empty edit so we never save a note that renders as a blank card; false means "not committed", keep the editor open.
    const trimmed = body.trim()
    if (!trimmed) {
      return false
    }

    // Missing notes return false to keep draft; unchanged body returns true to close editor without mutation.
    const existing = readOwnedDiffComments(get(), owner) ?? []
    const existingIdx = existing.findIndex((c) => c.id === commentId)
    if (existingIdx === -1) {
      return false
    }
    if (existing[existingIdx].body === trimmed) {
      return true
    }

    const result = mutateDiffComments(set, owner, (current) => {
      const idx = current.findIndex((c) => c.id === commentId)
      if (idx === -1) {
        return null
      }
      if (current[idx].body === trimmed) {
        return null
      }
      const next = current.slice()
      // Why: editing a sent note makes the agent's copy stale, so reset sentAt to re-queue it for the next Send.
      next[idx] = { ...current[idx], body: trimmed, sentAt: undefined }
      return next
    })
    if (!result) {
      // Why: comment vanished or the same body was already written between pre-check and set; treat as success so the editor closes.
      return true
    }
    try {
      await enqueueDiffCommentPersist(set, worktreeId, get, result)
      return true
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      return false
    }
  },

  clearDeliveredDiffComments: async (owner, comments) => {
    const shown = readOwnedDiffComments(get(), owner)
    if (!shown) {
      reportLostDiffCommentOwner('clear')
      return false
    }
    // Why: some launch paths report one success twice; only unchanged notes not already being removed need the host.
    const pending = comments.filter(
      (snapshot) =>
        !cleanupsInFlight.has(diffCommentSendKey(owner, snapshot)) &&
        shown.some((note) => matchesDeliveredDiffComment(note, snapshot))
    )
    if (pending.length === 0) {
      return true
    }
    const keys = pending.map((note) => diffCommentSendKey(owner, note))
    for (const key of keys) {
      cleanupsInFlight.add(key)
    }
    const outcome = enqueueDeliveredDiffCommentCleanup(set, get, owner, pending).then(
      () => {
        dismissSentNotesStillListedToast()
        return true
      },
      (err: unknown) => {
        console.error('Failed to remove delivered review notes:', err)
        // Why: the recipient already has these notes. Mark them sent before the hold releases so they never
        // return to Send; an edit clears the mark, and Remove asks the host again.
        markDeliveredDiffCommentsSent(set, get, owner, pending)
        showSentNotesStillListedToast(() => void get().clearDeliveredDiffComments(owner, pending))
        return false
      }
    )
    holdNotesForSend(keys, outcome)
    const ok = await outcome
    for (const key of keys) {
      cleanupsInFlight.delete(key)
    }
    if (ok) {
      recordReviewNoteInteraction(get)
    }
    return ok
  },

  markDiffCommentsSent: async (owner, commentIds, sentAt = Date.now()) => {
    if (!readOwnedDiffComments(get(), owner)) {
      return false
    }
    const worktreeId = owner.worktreeId
    if (commentIds.length === 0) {
      return true
    }
    const ids = new Set(commentIds)
    const result = mutateDiffComments(set, owner, (existing) => {
      let changed = false
      const next = existing.map((comment) => {
        if (!ids.has(comment.id) || comment.sentAt === sentAt) {
          return comment
        }
        changed = true
        return { ...comment, sentAt }
      })
      return changed ? next : null
    })
    if (!result) {
      return true
    }
    try {
      await enqueueDiffCommentPersist(set, worktreeId, get, result)
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      return false
    }
    recordReviewNoteInteraction(get)
    return true
  },

  deleteDiffComment: async (owner, commentId) => {
    if (!readOwnedDiffComments(get(), owner)) {
      reportLostDiffCommentOwner('clear')
      return
    }
    const worktreeId = owner.worktreeId
    const result = mutateDiffComments(set, owner, (existing) => {
      const next = existing.filter((c) => c.id !== commentId)
      return next.length === existing.length ? null : next
    })
    if (!result) {
      return
    }
    try {
      // Why: serialize through the per-worktree queue so concurrent writes can't land out of call order.
      await enqueueDiffCommentPersist(set, worktreeId, get, result)
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
    }
  },

  deleteDiffCommentsByIds: async (owner, commentIds) => {
    if (!readOwnedDiffComments(get(), owner)) {
      return false
    }
    const ids = new Set(commentIds)
    const result = mutateDiffComments(set, owner, (existing) => {
      const next = existing.filter((c) => !ids.has(c.id))
      return next.length === existing.length ? null : next
    })
    if (!result) {
      return true
    }
    try {
      await enqueueDiffCommentPersist(set, owner.worktreeId, get, result)
      return true
    } catch (err) {
      console.error('Failed to persist diff comments:', err)
      return false
    }
  }
})
