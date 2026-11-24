import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import {
  ABSENT_NOTE_VERSION,
  diffCommentVersion,
  type FolderDiffCommentMergeRequest,
  type FolderDiffCommentReceipt
} from '../../../../../shared/file-review/folder-diff-comment-merge'
import { findOwnedFolder, type DiffCommentOwner } from './diff-comment-owner'
import {
  FolderNoteWriteNotSentError,
  isDefinitiveFolderNoteRefusal,
  mergeFolderDiffComments
} from './folder-note-merge-call'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { recordFolderNotesFence } from './folder-note-fence'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'

type FolderOwner = Extract<DiffCommentOwner, { kind: 'folder' }>
type HostReceipt = Extract<FolderDiffCommentReceipt, { verdict: unknown }>

/** The full catalog row the owner names, including its incarnation stamp. */
function ownedFolderRow(state: AppState, owner: FolderOwner): FolderWorkspace | undefined {
  const target = findOwnedFolder(state, owner)
  return target ? state.folderWorkspaces.find((row) => row === target) : undefined
}
type Set = Parameters<StateCreator<AppState>>[0]

/** One user action on a folder copy's notes: the ids it changed and what it changed them to. */
export type FolderNoteAction = {
  seq: number
  /** id → the version the action leaves (undefined: deleted). */
  delta: Map<string, DiffComment | undefined>
  before: Map<string, DiffComment | undefined>
  // Captured when the user acted, so a write never reaches another row or machine.
  expectedCreatedAt: number | undefined
  pairingRevision: number | undefined
  // Enqueued while the protected backlog was full: refused without a write.
  overflow?: boolean
}

/**
 * After a failed save the host may hold the failed change or not; until an acknowledged protected
 * write ends a burst, every write of this copy is one merge-only action delta, and what the copy
 * shows is derived: the last host-issued list plus the unsettled actions in call order.
 */
type ProtectedCopy = {
  owner: FolderOwner
  failed: boolean
  lastRunAcknowledged: boolean
  authoritative: DiffComment[]
  provisional: boolean
  pending: FolderNoteAction[]
  // The array this queue last put in state; anything else there came from outside (a refresh).
  shown: DiffComment[] | undefined
  observationGeneration: number
  dirty: boolean
  readAttempts: number
  actionSeq: number
}

// Why a bound: a host refusing every write must not grow an unbounded backlog of retained actions.
export const MAX_PENDING_FOLDER_NOTE_ACTIONS = 256

const protectedCopies = new Map<string, ProtectedCopy>()
// Actions enqueued but not settled, kept in ordinary mode too, so protection knows what is queued.
const unsettledByCopy = new Map<string, FolderNoteAction[]>()
let nextActionSeq = 0

export function isFolderNoteProtectionActive(copyKey: string): boolean {
  return protectedCopies.has(copyKey)
}

function versionsDiffer(a: DiffComment | undefined, b: DiffComment | undefined): boolean {
  return diffCommentVersion(a) !== diffCommentVersion(b)
}

/** Records an action when it is enqueued; its delta is fixed now, from the lists the user acted on. */
export function trackFolderNoteAction(
  copyKey: string,
  owner: FolderOwner,
  get: () => AppState,
  previous: readonly DiffComment[] | undefined,
  next: readonly DiffComment[]
): FolderNoteAction {
  const beforeById = new Map((previous ?? []).map((note) => [note.id, note]))
  const afterById = new Map(next.map((note) => [note.id, note]))
  const delta = new Map<string, DiffComment | undefined>()
  const before = new Map<string, DiffComment | undefined>()
  for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
    if (versionsDiffer(beforeById.get(id), afterById.get(id))) {
      delta.set(id, afterById.get(id))
      before.set(id, beforeById.get(id))
    }
  }
  const action: FolderNoteAction = {
    seq: ++nextActionSeq,
    delta,
    before,
    expectedCreatedAt: ownedFolderRow(get(), owner)?.createdAt,
    pairingRevision: owner.runtimeEnvironmentId
      ? getRuntimeEnvironmentRevision(owner.runtimeEnvironmentId)
      : undefined
  }
  unsettledByCopy.set(copyKey, [...(unsettledByCopy.get(copyKey) ?? []), action])
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
  const remaining = (unsettledByCopy.get(copyKey) ?? []).filter((entry) => entry !== action)
  if (remaining.length === 0) {
    unsettledByCopy.delete(copyKey)
  } else {
    unsettledByCopy.set(copyKey, remaining)
  }
}

function observe(copy: ProtectedCopy, list: readonly DiffComment[] | undefined): void {
  copy.authoritative = [...(list ?? [])]
  copy.provisional = true
  copy.observationGeneration += 1
  copy.dirty = true
  copy.shown = list as DiffComment[] | undefined
}

/** The last host-issued (or observed) list with each unsettled action applied in call order. */
export function overlayFolderNotes(
  base: readonly DiffComment[],
  pending: readonly FolderNoteAction[]
): DiffComment[] {
  const overlay = new Map<string, DiffComment | undefined>()
  for (const action of pending) {
    for (const [id, note] of action.delta) {
      overlay.set(id, note)
    }
  }
  if (overlay.size === 0) {
    return [...base]
  }
  const result: DiffComment[] = []
  const placed = new Set<string>()
  for (const note of base) {
    if (!overlay.has(note.id)) {
      result.push(note)
      continue
    }
    placed.add(note.id)
    const replacement = overlay.get(note.id)
    if (replacement) {
      result.push(replacement)
    }
  }
  for (const [id, note] of overlay) {
    if (note && !placed.has(id)) {
      result.push(note)
    }
  }
  return result
}

/** Shows the derived list, unless something outside the queue replaced the copy's list first. */
function publish(copy: ProtectedCopy, get: () => AppState, set: Set): void {
  const current = findOwnedFolder(get(), copy.owner)?.diffComments
  if (current !== copy.shown) {
    observe(copy, current)
  }
  const display = overlayFolderNotes(copy.authoritative, copy.pending)
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
export function enterFolderNoteProtection(
  copyKey: string,
  owner: FolderOwner,
  failed: FolderNoteAction,
  floor: readonly DiffComment[],
  get: () => AppState,
  set: Set
): void {
  settleOrdinaryFolderNoteAction(copyKey, failed)
  const copy: ProtectedCopy = {
    owner,
    failed: true,
    lastRunAcknowledged: false,
    authoritative: [...floor],
    provisional: true,
    pending: [...(unsettledByCopy.get(copyKey) ?? [])],
    shown: findOwnedFolder(get(), owner)?.diffComments,
    observationGeneration: 0,
    dirty: true,
    readAttempts: 0,
    actionSeq: 0
  }
  protectedCopies.set(copyKey, copy)
  publish(copy, get, set)
}

function requestFor(
  owner: FolderOwner,
  action: FolderNoteAction,
  mode: 'merge' | 'read',
  expectedCreatedAt: number
): FolderDiffCommentMergeRequest {
  const scope = parseWorkspaceKey(owner.worktreeId)
  const folderWorkspaceId = scope?.type === 'folder' ? scope.folderWorkspaceId : owner.worktreeId
  return {
    requestId: `folder-notes-${action.seq}-${mode}-${Date.now().toString(36)}`,
    folderWorkspaceId,
    expectedCreatedAt,
    mode,
    diffCommentsBase:
      mode === 'read' ? [] : [...action.before.values()].filter((note) => note !== undefined),
    diffComments:
      mode === 'read' ? [] : [...action.delta.values()].filter((note) => note !== undefined)
  }
}

/** A receipt answers this request, for this row incarnation, and names every touched id once. */
function validReceipt(
  receipt: unknown,
  request: FolderDiffCommentMergeRequest
): receipt is HostReceipt {
  if (typeof receipt !== 'object' || receipt === null) {
    return false
  }
  const candidate = receipt as Partial<HostReceipt>
  if (
    candidate.requestId !== request.requestId ||
    candidate.folderWorkspaceId !== request.folderWorkspaceId ||
    (candidate.outcome !== 'applied' && candidate.outcome !== 'read') ||
    candidate.outcome !== (request.mode === 'merge' ? 'applied' : 'read') ||
    candidate.createdAt !== request.expectedCreatedAt ||
    !Array.isArray(candidate.verdict)
  ) {
    return false
  }
  const touched = new Set(
    [...request.diffCommentsBase, ...request.diffComments].map((note) => note.id)
  )
  const named = new Set(candidate.verdict.map((entry) => entry.id))
  return named.size === candidate.verdict.length && [...touched].every((id) => named.has(id))
}

function onlySentAtChanged(before: DiffComment | undefined, after: DiffComment | undefined) {
  if (!before || !after) {
    return false
  }
  return (
    diffCommentVersion({ ...before, sentAt: undefined }) ===
    diffCommentVersion({ ...after, sentAt: undefined })
  )
}

/** Whether the host holds what this action meant for every id it changed. */
function actionSatisfied(
  action: FolderNoteAction,
  verdict: HostReceipt['verdict']
): boolean {
  const held = new Map(verdict.map((entry) => [entry.id, entry.version]))
  return [...action.delta].every(([id, intended]) => {
    const version = held.get(id)
    if (version === diffCommentVersion(intended)) {
      return true
    }
    // Marking a note sent has nothing left to do once another device deleted it.
    return version === ABSENT_NOTE_VERSION && onlySentAtChanged(action.before.get(id), intended)
  })
}

export class FolderNoteNotSavedError extends Error {
  constructor(reason: string) {
    super(`Review notes were not saved (${reason}).`)
    this.name = 'FolderNoteNotSavedError'
  }
}

function settle(copyKey: string, copy: ProtectedCopy, action: FolderNoteAction): void {
  copy.pending = copy.pending.filter((entry) => entry !== action)
  settleOrdinaryFolderNoteAction(copyKey, action)
}

/** Runs one queued action of a protected copy; rejects when the action did not take effect. */
export async function runProtectedFolderNoteAction(args: {
  copyKey: string
  action: FolderNoteAction
  get: () => AppState
  set: Set
  enqueueRead: (task: () => Promise<void>) => void
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
    settle(copyKey, copy, action)
    publish(copy, get, set)
    afterSettle(args, copy)
    throw new FolderNoteNotSavedError(reason)
  }
  if (action.delta.size === 0) {
    // Nothing of its own to send: its outcome rests on earlier work this copy cannot confirm.
    settle(copyKey, copy, action)
    afterSettle(args, copy)
    throw new FolderNoteNotSavedError('unconfirmed')
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
  const request = requestFor(owner, action, 'merge', action.expectedCreatedAt)
  const generationAtSend = copy.observationGeneration
  let receipt: unknown
  try {
    receipt = await mergeFolderDiffComments(owner, request)
  } catch (err) {
    return fail(
      err instanceof FolderNoteWriteNotSentError ? err.message : 'no answer',
      !isDefinitiveFolderNoteRefusal(err)
    )
  }
  const outcome = (receipt as { outcome?: unknown } | null)?.outcome
  if (!validReceipt(receipt, request)) {
    const refusal = typeof outcome === 'string' && outcome !== 'applied' && outcome !== 'read'
    // A refusal names its request: the host checked before touching the row.
    const definitive =
      refusal && (receipt as { requestId?: unknown }).requestId === request.requestId
    return fail(definitive ? String(outcome) : 'unverifiable reply', !definitive)
  }
  copy.lastRunAcknowledged = true
  if (receipt.snapshot && copy.observationGeneration === generationAtSend) {
    copy.authoritative = receipt.snapshot
    copy.provisional = false
    recordFolderNotesFence(get, owner)
  } else {
    copy.dirty = true
  }
  const satisfied = actionSatisfied(action, receipt.verdict)
  copy.readAttempts = 0
  settle(copyKey, copy, action)
  publish(copy, get, set)
  afterSettle(args, copy)
  if (!satisfied) {
    throw new FolderNoteNotSavedError('another change won')
  }
}

/** At a quiet tail: end protection, or reconcile the display with one keyed read. */
function afterSettle(
  args: {
    copyKey: string
    get: () => AppState
    set: Set
    enqueueRead: (task: () => Promise<void>) => void
  },
  copy: ProtectedCopy
): void {
  if (copy.pending.length > 0) {
    return
  }
  if (copy.lastRunAcknowledged) {
    copy.failed = false
  }
  if (!copy.dirty && !copy.provisional) {
    if (!copy.failed) {
      protectedCopies.delete(args.copyKey)
    }
    return
  }
  // One read per quiet tail, plus one follow-up after a genuine invalidation; churn waits for a real event.
  if (copy.readAttempts >= 2) {
    return
  }
  copy.readAttempts += 1
  args.enqueueRead(() => reconcile(args, copy))
}

async function reconcile(
  args: {
    copyKey: string
    get: () => AppState
    set: Set
    enqueueRead: (task: () => Promise<void>) => void
  },
  copy: ProtectedCopy
): Promise<void> {
  const { get, set } = args
  const expectedCreatedAt = ownedFolderRow(get(), copy.owner)?.createdAt
  if (protectedCopies.get(args.copyKey) !== copy || expectedCreatedAt === undefined) {
    return
  }
  const startedAt = { generation: copy.observationGeneration, actions: copy.actionSeq }
  const request = requestFor(
    copy.owner,
    {
      seq: ++nextActionSeq,
      delta: new Map(),
      before: new Map(),
      expectedCreatedAt,
      pairingRevision: undefined
    },
    'read',
    expectedCreatedAt
  )
  let receipt: unknown
  try {
    receipt = await mergeFolderDiffComments(copy.owner, request)
  } catch {
    // Unreadable: the display stays provisional and protection armed until a real refresh or action.
    return
  }
  if (!validReceipt(receipt, request) || !receipt.snapshot) {
    return
  }
  const current = ownedFolderRow(get(), copy.owner)
  const stillQuiet =
    protectedCopies.get(args.copyKey) === copy &&
    copy.pending.length === 0 &&
    copy.actionSeq === startedAt.actions &&
    copy.observationGeneration === startedAt.generation &&
    current?.createdAt === expectedCreatedAt &&
    current?.diffComments === copy.shown
  if (!stillQuiet) {
    // Invalidated by a newer action or observation: one fresh read at the next quiet tail.
    if (copy.pending.length === 0 && copy.observationGeneration !== startedAt.generation) {
      afterSettle(args, copy)
    }
    return
  }
  copy.authoritative = receipt.snapshot
  copy.provisional = false
  copy.dirty = false
  copy.readAttempts = 0
  recordFolderNotesFence(get, copy.owner)
  publish(copy, get, set)
  // A read cannot clear a failed tail; only an acknowledged write ends protection.
  if (!copy.failed) {
    protectedCopies.delete(args.copyKey)
  }
}

/** Test seam: forget all protection state between cases. */
export function resetFolderNoteProtectionForTests(): void {
  protectedCopies.clear()
  unsettledByCopy.clear()
}
