import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import { findOwnedFolder, diffCommentOwnerKey, type DiffCommentOwner } from './diff-comment-owner'
import {
  FolderNoteWriteNotSentError,
  isDefinitiveFolderNoteRefusal,
  isUnsupportedFolderNoteMerge,
  mergeFolderDiffComments
} from './folder-note-merge-call'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import {
  awaitFolderNoteActionsTouching,
  createFolderNoteAction,
  resetFolderNoteActionsForTests,
  settleFolderNoteAction,
  unsettledFolderNoteActions,
  type FolderNoteAction,
  type FolderOwner
} from './folder-note-actions'
import {
  checkFolderNoteReceipt,
  folderNoteActionSatisfied,
  folderNoteRequest,
  isDefinitiveRefusalReply
} from './folder-note-receipt'
import {
  adoptHostList,
  MAX_PENDING_FOLDER_NOTE_ACTIONS,
  noticeOutsideReplacement,
  observe,
  protectedCopies,
  publish,
  settle,
  type EnqueueFolderNoteRead,
  type ProtectedCopy,
  type Set
} from './folder-note-protected-copy'
import { afterSettle } from './folder-note-reconcile'

export function isFolderNoteProtectionActive(copyKey: string): boolean {
  return protectedCopies.has(copyKey)
}

export class FolderNoteNotSavedError extends Error {
  constructor(reason: string) {
    super(`Review notes were not saved (${reason}).`)
    this.name = 'FolderNoteNotSavedError'
  }
}

/** Records an action when it is enqueued; its delta is fixed now, from the lists the user acted on. */
export function trackFolderNoteAction(
  copyKey: string,
  owner: FolderOwner,
  get: () => AppState,
  previous: readonly DiffComment[] | undefined,
  next: readonly DiffComment[]
): FolderNoteAction {
  const action = createFolderNoteAction(copyKey, owner, get, previous, next)
  const copy = protectedCopies.get(copyKey)
  if (copy) {
    // The user acted on what state showed; a list the queue did not put there is a newer observation.
    if (previous !== copy.shown) {
      observe(copy, previous)
    }
    action.overflow = copy.pending.length >= MAX_PENDING_FOLDER_NOTE_ACTIONS
    copy.pending.push(action)
    copy.actionSeq += 1
    copy.shown = next as DiffComment[]
  }
  return action
}

export function settleOrdinaryFolderNoteAction(copyKey: string, action: FolderNoteAction): void {
  settleFolderNoteAction(copyKey, action, true)
}

/**
 * For a protected copy, whether the queued actions that make a no-op look like one took effect;
 * true at once when nothing queued touches what `matches` selects (a genuinely empty scope).
 */
export function awaitProtectedFolderNoteDependency(
  owner: DiffCommentOwner,
  matches: (id: string, note: DiffComment | undefined) => boolean
): Promise<boolean> {
  const copyKey = diffCommentOwnerKey(owner)
  if (owner.kind !== 'folder' || !protectedCopies.has(copyKey)) {
    return Promise.resolve(true)
  }
  return awaitFolderNoteActionsTouching(copyKey, matches)
}

/** After a new action on a protected copy, shows the derived list (it differs from the optimistic one after a refresh). */
export function refreshProtectedFolderDisplay(
  copyKey: string,
  get: () => AppState,
  set: Set
): void {
  const copy = protectedCopies.get(copyKey)
  if (copy) {
    publish(copy, get, set)
  }
}

/** Starts protection after an ordinary write failed; the queued actions behind it become protected. */
export function enterFolderNoteProtection(args: {
  copyKey: string
  owner: FolderOwner
  failed: FolderNoteAction
  floor: readonly DiffComment[]
  get: () => AppState
  set: Set
  enqueueRead: EnqueueFolderNoteRead
}): void {
  const { copyKey, owner, get, set } = args
  settleFolderNoteAction(copyKey, args.failed, false)
  const copy: ProtectedCopy = {
    owner,
    enqueueRead: args.enqueueRead,
    failed: true,
    lastRunAcknowledged: false,
    authoritative: [...args.floor],
    provisional: true,
    pending: [...unsettledFolderNoteActions(copyKey)],
    acknowledged: [],
    shown: findOwnedFolder(get(), owner)?.diffComments,
    observationGeneration: 0,
    dirty: true,
    readAttempts: 0,
    readInFlight: false,
    actionSeq: 0,
    mergeUnsupported: false,
    reportedNoSnapshot: false
  }
  protectedCopies.set(copyKey, copy)
  publish(copy, get, set)
  // Nothing queued behind the failure: reconcile the display now (whether the failed write landed).
  afterSettle(copyKey, copy, get, set)
}

/** Runs one queued action of a protected copy; rejects when the action did not take effect. */
export async function runProtectedFolderNoteAction(args: {
  copyKey: string
  action: FolderNoteAction
  get: () => AppState
  set: Set
}): Promise<void> {
  const { copyKey, action, get, set } = args
  const copy = protectedCopies.get(copyKey)
  if (!copy) {
    return
  }
  const fail = (reason: string, unverifiable: boolean): never => {
    copy.failed = true
    copy.lastRunAcknowledged = false
    copy.dirty ||= unverifiable
    copy.readAttempts = 0
    settle(copyKey, copy, action, false)
    publish(copy, get, set)
    afterSettle(copyKey, copy, get, set)
    throw new FolderNoteNotSavedError(reason)
  }
  if (action.delta.size === 0) {
    // Nothing of its own to send: it took effect only if what it rested on did (all settled by now).
    const outcomes = await Promise.all(action.dependsOn.map((entry) => entry.outcome))
    if (!outcomes.every(Boolean)) {
      return fail('unconfirmed', false)
    }
    settle(copyKey, copy, action, true)
    afterSettle(copyKey, copy, get, set)
    return
  }
  if (action.overflow) {
    return fail('backlog', false)
  }
  const owner = copy.owner
  if (
    action.expectedCreatedAt === undefined ||
    (owner.runtimeEnvironmentId &&
      getRuntimeEnvironmentRevision(owner.runtimeEnvironmentId) !== action.pairingRevision)
  ) {
    return fail('host changed', false)
  }
  const request = folderNoteRequest(owner, action, 'merge', action.expectedCreatedAt)
  const generationAtSend = copy.observationGeneration
  let reply: unknown
  try {
    reply = await mergeFolderDiffComments(owner, request)
  } catch (err) {
    copy.mergeUnsupported = isUnsupportedFolderNoteMerge(err)
    return fail(
      err instanceof FolderNoteWriteNotSentError ? err.message : 'no answer',
      !isDefinitiveFolderNoteRefusal(err)
    )
  }
  const receipt = checkFolderNoteReceipt(reply, request)
  if (!receipt) {
    const refusal = isDefinitiveRefusalReply(reply, request)
    return fail(refusal ?? 'unverifiable reply', refusal === null)
  }
  copy.lastRunAcknowledged = true
  copy.mergeUnsupported = false
  const satisfied = folderNoteActionSatisfied(action, receipt.verdict)
  noticeOutsideReplacement(copy, get)
  if (receipt.snapshot && copy.observationGeneration === generationAtSend) {
    // Committed after the send, so newer than every observation made before it.
    adoptHostList(copy, get, receipt.snapshot)
  } else {
    copy.dirty = true
    if (satisfied) {
      copy.acknowledged.push(action)
    }
  }
  copy.readAttempts = 0
  settle(copyKey, copy, action, satisfied)
  publish(copy, get, set)
  afterSettle(copyKey, copy, get, set)
  if (!satisfied) {
    throw new FolderNoteNotSavedError('another change won')
  }
}

/** Test seam: forget all protection state between cases. */
export function resetFolderNoteProtectionForTests(): void {
  protectedCopies.clear()
  resetFolderNoteActionsForTests()
}
