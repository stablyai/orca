import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import { diffCommentOwnerKey, type DiffCommentOwner } from './diff-comment-owner'
import {
  FolderNoteWriteNotSentError,
  isDefinitiveFolderNoteRefusal,
  mergeFolderDiffComments
} from './folder-note-merge-call'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import {
  createFolderNoteAction,
  NOTHING_SATISFIED,
  ownedFolderRow,
  resetFolderNoteActionsForTests,
  settleFolderNoteAction,
  unsettledFolderNoteActions,
  type FolderNoteAction,
  type FolderNoteScope,
  type FolderOwner
} from './folder-note-actions'
import {
  checkFolderNoteReceipt,
  folderNoteRequest,
  isDefinitiveRefusalReply
} from './folder-note-receipt'
import {
  adoptHostList,
  catalogGenerationOf,
  isCurrentCopy,
  MAX_PENDING_FOLDER_NOTE_ACTIONS,
  noticeOutsideReplacement,
  observe,
  protectedCopies,
  publish,
  recordConfirmed,
  retireIfReplaced,
  sentActions,
  settle,
  type EnqueueFolderNoteRead,
  type ProtectedCopy,
  type Set
} from './folder-note-protected-copy'
import { afterSettle } from './folder-note-reconcile'
import { unmetDependencies } from './folder-note-dependencies'

export { awaitProtectedFolderNoteDependency } from './folder-note-dependencies'

export function isFolderNoteProtectionActive(copyKey: string): boolean {
  return protectedCopies.has(copyKey)
}

export class FolderNoteNotSavedError extends Error {
  constructor(reason: string) {
    super(`Review notes were not saved (${reason}).`)
    this.name = 'FolderNoteNotSavedError'
  }
}

/**
 * Whether a new action on this copy may be made at all. Checked before the optimistic change is
 * shown, so a full protected backlog never shows a note it will not try to save.
 */
export function admitFolderNoteAction(owner: DiffCommentOwner): boolean {
  const copyKey = diffCommentOwnerKey(owner)
  return (
    owner.kind !== 'folder' ||
    !protectedCopies.has(copyKey) ||
    unsettledFolderNoteActions(copyKey).length < MAX_PENDING_FOLDER_NOTE_ACTIONS
  )
}

/** Records an action when it is enqueued; its delta is fixed now, from the lists the user acted on. */
export function trackFolderNoteAction(args: {
  copyKey: string
  owner: FolderOwner
  get: () => AppState
  previous: readonly DiffComment[] | undefined
  next: readonly DiffComment[]
  scope?: FolderNoteScope
}): FolderNoteAction {
  const action = createFolderNoteAction(args)
  const copy = protectedCopies.get(args.copyKey)
  // Why not noticeOutsideReplacement: state already holds this action's own optimistic list.
  if (copy && retireIfReplaced(copy, args.get)) {
    // The user acted on what state showed; a list the queue did not put there is a newer observation.
    if (args.previous !== copy.shown || copy.authoritative === undefined) {
      observe(copy, args.previous)
    }
    copy.pending.push(action)
    copy.actionSeq += 1
    copy.shown = args.next as DiffComment[]
  }
  return action
}

export function settleOrdinaryFolderNoteAction(copyKey: string, action: FolderNoteAction): void {
  settleFolderNoteAction(copyKey, action, new Set(action.delta.keys()))
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

/**
 * Starts protection after an ordinary write failed; the queued actions behind it become protected.
 * `queueArrays` are the lists the queue itself put in state: anything else there is an observation
 * newer than the floor (a catalog fetch while the write was out), and it is kept.
 */
export function enterFolderNoteProtection(args: {
  copyKey: string
  owner: FolderOwner
  failed: FolderNoteAction
  floor: readonly DiffComment[]
  queueArrays: readonly (readonly DiffComment[] | undefined)[]
  get: () => AppState
  set: Set
  enqueueRead: EnqueueFolderNoteRead
}): void {
  const { copyKey, owner, get, set, failed } = args
  settleFolderNoteAction(copyKey, failed, NOTHING_SATISFIED)
  const row = ownedFolderRow(get(), owner)
  // Bound to the row and pairing the failed save was made on; work made on a successor is its own.
  const sameRow = (action: FolderNoteAction) =>
    action.expectedCreatedAt === failed.expectedCreatedAt &&
    action.pairingRevision === failed.pairingRevision
  const queued = unsettledFolderNoteActions(copyKey).filter(sameRow)
  const replaced =
    failed.expectedCreatedAt === undefined ||
    row?.createdAt !== failed.expectedCreatedAt ||
    (!!owner.runtimeEnvironmentId &&
      getRuntimeEnvironmentRevision(owner.runtimeEnvironmentId) !== failed.pairingRevision)
  if (replaced) {
    // The failed save's row is already gone: its queued work is refused unsent, the successor shows none of it.
    for (const action of queued) {
      action.refusedUnsent = 'host changed'
      settleFolderNoteAction(copyKey, action, NOTHING_SATISFIED)
    }
    return
  }
  const copy: ProtectedCopy = {
    key: copyKey,
    owner,
    createdAt: failed.expectedCreatedAt,
    pairingRevision: failed.pairingRevision,
    enqueueRead: args.enqueueRead,
    failed: true,
    lastRunAcknowledged: false,
    ackGeneration: undefined,
    authoritative: [...args.floor],
    baseFromHost: false,
    provisional: true,
    pending: queued.slice(0, MAX_PENDING_FOLDER_NOTE_ACTIONS),
    confirmed: new Map(),
    shown: row?.diffComments,
    observationGeneration: 0,
    dirty: true,
    readAttempts: 0,
    readInFlight: false,
    readToken: 0,
    actionSeq: 0,
    reportedNoSnapshot: false
  }
  // The ordinary backlog crosses into protection bounded: the excess is refused, never sent.
  for (const action of queued.slice(MAX_PENDING_FOLDER_NOTE_ACTIONS)) {
    action.refusedUnsent = 'backlog'
    settleFolderNoteAction(copyKey, action, NOTHING_SATISFIED)
  }
  if (!args.queueArrays.includes(copy.shown)) {
    observe(copy, copy.shown)
  }
  protectedCopies.set(copyKey, copy)
  publish(copy, get, set)
  // Nothing queued behind the failure: reconcile the display now (whether the failed write landed).
  afterSettle(copy, get, set)
}

function failRun(
  copy: ProtectedCopy,
  action: FolderNoteAction,
  get: () => AppState,
  set: Set,
  reason: string,
  unverifiable: boolean
): never {
  copy.failed = true
  copy.lastRunAcknowledged = false
  copy.ackGeneration = undefined
  copy.dirty ||= unverifiable
  copy.readAttempts = 0
  settle(copy, action, NOTHING_SATISFIED)
  publish(copy, get, set)
  afterSettle(copy, get, set)
  throw new FolderNoteNotSavedError(reason)
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
  // Why no await before the send: a copy retired while this yielded could otherwise still send.
  if (
    !copy ||
    action.refusedUnsent ||
    !copy.pending.includes(action) ||
    !noticeOutsideReplacement(copy, get)
  ) {
    // Retired with its copy (the row was replaced) or past the backlog bound: never sent.
    settleFolderNoteAction(copyKey, action, NOTHING_SATISFIED)
    throw new FolderNoteNotSavedError(action.refusedUnsent ?? 'host changed')
  }
  const fail = (reason: string, unverifiable: boolean): never =>
    failRun(copy, action, get, set, reason, unverifiable)
  // Ids it rests on settled before it ran (the queue is serial); it took effect only if they hold.
  if (unmetDependencies(copy, action.borrowed, action.scope).length > 0) {
    return fail('unconfirmed', false)
  }
  if (action.delta.size === 0) {
    settle(copy, action, NOTHING_SATISFIED)
    afterSettle(copy, get, set)
    return
  }
  if (
    action.expectedCreatedAt === undefined ||
    action.expectedCreatedAt !== copy.createdAt ||
    (copy.owner.runtimeEnvironmentId &&
      getRuntimeEnvironmentRevision(copy.owner.runtimeEnvironmentId) !== action.pairingRevision)
  ) {
    return fail('host changed', false)
  }
  const request = folderNoteRequest(copy.owner, action, 'merge', action.expectedCreatedAt)
  const generationAtSend = copy.observationGeneration
  // Why at the handoff: a paired call first awaits compatibility, and the copy can retire meanwhile.
  const markSentIfStillLive = (): void => {
    if (
      action.refusedUnsent ||
      !isCurrentCopy(copy) ||
      !copy.pending.includes(action) ||
      !retireIfReplaced(copy, get) ||
      (!!copy.owner.runtimeEnvironmentId &&
        getRuntimeEnvironmentRevision(copy.owner.runtimeEnvironmentId) !== action.pairingRevision)
    ) {
      throw new FolderNoteWriteNotSentError(action.refusedUnsent ?? 'host changed')
    }
    sentActions.add(action)
  }
  let reply: unknown
  try {
    reply = await mergeFolderDiffComments(copy.owner, request, markSentIfStillLive)
  } catch (err) {
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
  // A row replaced while this was out shows nothing more, but the caller still learns what the host did.
  const showing = isCurrentCopy(copy) && noticeOutsideReplacement(copy, get)
  const satisfied = recordConfirmed(copy, get, action, receipt.verdict)
  if (showing) {
    copy.lastRunAcknowledged = true
    copy.ackGeneration = catalogGenerationOf(copy, get)
    if (receipt.snapshot && copy.observationGeneration === generationAtSend) {
      // Committed after the send, so newer than every observation made before it.
      adoptHostList(copy, get, receipt.snapshot)
    } else {
      copy.dirty = true
    }
    copy.readAttempts = 0
  }
  settle(copy, action, satisfied)
  if (showing) {
    publish(copy, get, set)
    afterSettle(copy, get, set)
  }
  if (![...action.delta.keys()].every((id) => satisfied.has(id))) {
    throw new FolderNoteNotSavedError('another change won')
  }
}

/** Test seam: forget all protection state between cases. */
export function resetFolderNoteProtectionForTests(): void {
  protectedCopies.clear()
  resetFolderNoteActionsForTests()
}
