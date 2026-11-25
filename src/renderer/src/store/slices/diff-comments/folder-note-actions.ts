import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import { diffCommentVersion } from '../../../../../shared/file-review/folder-diff-comment-merge'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { findOwnedFolder, type DiffCommentOwner } from './diff-comment-owner'

export type FolderOwner = Extract<DiffCommentOwner, { kind: 'folder' }>

/** Which notes a user action is about, beyond the ids it changes itself (a clear's whole scope). */
export type FolderNoteScope = (id: string, note: DiffComment | undefined) => boolean

/** One user action on a folder copy's notes: the ids it changed and what it changed them to. */
export type FolderNoteAction = {
  seq: number
  /** id → the version the action leaves (undefined: deleted). */
  delta: Map<string, DiffComment | undefined>
  before: Map<string, DiffComment | undefined>
  // Captured when the user acted, so a write never reaches another row or machine.
  expectedCreatedAt: number | undefined
  pairingRevision: number | undefined
  // Ids in the action's scope that look done only because an earlier queued action changed them:
  // id → that latest earlier action. The action took effect only if those did too.
  borrowed: Map<string, FolderNoteAction>
  /** Resolves once with the ids whose intended version the host holds (empty: not saved). */
  outcome: Promise<ReadonlySet<string>>
  resolveOutcome: (satisfied: ReadonlySet<string>) => void
  // Settled without ever being sent (backlog bound, or its folder row was replaced): why.
  refusedUnsent?: string
}

// Actions enqueued but not settled, kept in ordinary mode too, so protection knows what is queued.
const unsettledByCopy = new Map<string, FolderNoteAction[]>()
let nextActionSeq = 0

export function nextFolderNoteSeq(): number {
  nextActionSeq += 1
  return nextActionSeq
}

/** The full catalog row the owner names, including its incarnation stamp. */
export function ownedFolderRow(state: AppState, owner: FolderOwner): FolderWorkspace | undefined {
  const target = findOwnedFolder(state, owner)
  return target ? state.folderWorkspaces.find((row) => row === target) : undefined
}

// Why the identity check first: a mutation keeps untouched notes by reference, so only changed ones are hashed.
function versionsDiffer(a: DiffComment | undefined, b: DiffComment | undefined): boolean {
  return a !== b && diffCommentVersion(a) !== diffCommentVersion(b)
}

function touches(action: FolderNoteAction, id: string, scope: FolderNoteScope): boolean {
  return action.delta.has(id) && (scope(id, action.delta.get(id)) || scope(id, action.before.get(id)))
}

/** For each id `scope` selects among queued actions, the latest queued action that changed it. */
export function latestQueuedActionsTouching(
  copyKey: string,
  scope: FolderNoteScope,
  except?: ReadonlySet<string>
): Map<string, FolderNoteAction> {
  const latest = new Map<string, FolderNoteAction>()
  for (const action of unsettledByCopy.get(copyKey) ?? []) {
    for (const id of action.delta.keys()) {
      if (!except?.has(id) && touches(action, id, scope)) {
        latest.set(id, action)
      }
    }
  }
  return latest
}

/** Whether every borrowed id ended as its latest queued action meant it to (they settle first). */
export async function borrowedTookEffect(
  borrowed: ReadonlyMap<string, FolderNoteAction>
): Promise<boolean> {
  for (const [id, action] of borrowed) {
    if (!(await action.outcome).has(id)) {
      return false
    }
  }
  return true
}

/** Builds an action from the lists the user acted on; its delta is fixed from now on. */
export function createFolderNoteAction(args: {
  copyKey: string
  owner: FolderOwner
  get: () => AppState
  previous: readonly DiffComment[] | undefined
  next: readonly DiffComment[]
  scope?: FolderNoteScope
}): FolderNoteAction {
  const { copyKey, owner, get } = args
  const beforeById = new Map((args.previous ?? []).map((note) => [note.id, note]))
  const afterById = new Map(args.next.map((note) => [note.id, note]))
  const delta = new Map<string, DiffComment | undefined>()
  const before = new Map<string, DiffComment | undefined>()
  for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
    if (versionsDiffer(beforeById.get(id), afterById.get(id))) {
      delta.set(id, afterById.get(id))
      before.set(id, beforeById.get(id))
    }
  }
  let resolveOutcome: (satisfied: ReadonlySet<string>) => void = () => {}
  const outcome = new Promise<ReadonlySet<string>>((resolve) => {
    resolveOutcome = resolve
  })
  // An action with no scope of its own (or nothing to send) rests on everything queued before it.
  const scope = args.scope ?? (delta.size === 0 ? () => true : undefined)
  const action: FolderNoteAction = {
    seq: nextFolderNoteSeq(),
    delta,
    before,
    expectedCreatedAt: ownedFolderRow(get(), owner)?.createdAt,
    pairingRevision: owner.runtimeEnvironmentId
      ? getRuntimeEnvironmentRevision(owner.runtimeEnvironmentId)
      : undefined,
    borrowed: scope ? latestQueuedActionsTouching(copyKey, scope, new Set(delta.keys())) : new Map(),
    outcome,
    resolveOutcome
  }
  unsettledByCopy.set(copyKey, [...(unsettledByCopy.get(copyKey) ?? []), action])
  return action
}

export function unsettledFolderNoteActions(copyKey: string): readonly FolderNoteAction[] {
  return unsettledByCopy.get(copyKey) ?? []
}

/** Retires an action from the queue bookkeeping and reports which of its ids took effect. */
export function settleFolderNoteAction(
  copyKey: string,
  action: FolderNoteAction,
  satisfied: ReadonlySet<string>
): void {
  const remaining = (unsettledByCopy.get(copyKey) ?? []).filter((entry) => entry !== action)
  if (remaining.length === 0) {
    unsettledByCopy.delete(copyKey)
  } else {
    unsettledByCopy.set(copyKey, remaining)
  }
  action.resolveOutcome(satisfied)
}

export const NOTHING_SATISFIED: ReadonlySet<string> = new Set()

/** What the host confirmed for one id: its version, or absence; `relocated` once it was absent. */
export type ConfirmedNote = { note: DiffComment | undefined; relocated: boolean; generation: number }

type Change = { note: DiffComment | undefined; appended: number | null }

function applyChange(
  changed: Map<string, Change>,
  appendOrder: string[],
  inBase: ReadonlySet<string>,
  id: string,
  note: DiffComment | undefined,
  relocate: boolean
): void {
  const prior = changed.get(id)
  const present = prior ? prior.note !== undefined : inBase.has(id)
  if (!note) {
    changed.set(id, { note: undefined, appended: null })
  } else if (present && !relocate) {
    changed.set(id, { note, appended: prior?.appended ?? null })
  } else {
    appendOrder.push(id)
    changed.set(id, { note, appended: appendOrder.length })
  }
}

/**
 * The base list with the confirmed notes, then each unsettled action in call order, applied the way
 * the host applies them: an edit stays in place, an add or a re-add after a delete goes last.
 * O(notes + confirmed + delta entries), no sort.
 */
export function overlayFolderNotes(
  base: readonly DiffComment[],
  confirmed: ReadonlyMap<string, ConfirmedNote>,
  pending: readonly FolderNoteAction[]
): DiffComment[] {
  if (confirmed.size === 0 && pending.every((action) => action.delta.size === 0)) {
    return [...base]
  }
  const inBase = new Set(base.map((note) => note.id))
  const changed = new Map<string, Change>()
  const appendOrder: string[] = []
  for (const [id, entry] of confirmed) {
    applyChange(changed, appendOrder, inBase, id, entry.note, entry.relocated)
  }
  for (const action of pending) {
    for (const [id, note] of action.delta) {
      applyChange(changed, appendOrder, inBase, id, note, false)
    }
  }
  const result: DiffComment[] = []
  for (const note of base) {
    const change = changed.get(note.id)
    if (!change) {
      result.push(note)
    } else if (change.note && change.appended === null) {
      result.push(change.note)
    }
  }
  appendOrder.forEach((id, index) => {
    const change = changed.get(id)
    // Only the id's last append counts; an earlier one was superseded.
    if (change?.note && change.appended === index + 1) {
      result.push(change.note)
    }
  })
  return result
}

export function resetFolderNoteActionsForTests(): void {
  unsettledByCopy.clear()
}
