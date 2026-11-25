import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import { diffCommentVersion } from '../../../../../shared/file-review/folder-diff-comment-merge'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { findOwnedFolder, type DiffCommentOwner } from './diff-comment-owner'

export type FolderOwner = Extract<DiffCommentOwner, { kind: 'folder' }>

/** One user action on a folder copy's notes: the ids it changed and what it changed them to. */
export type FolderNoteAction = {
  seq: number
  /** id → the version the action leaves (undefined: deleted). */
  delta: Map<string, DiffComment | undefined>
  before: Map<string, DiffComment | undefined>
  // Captured when the user acted, so a write never reaches another row or machine.
  expectedCreatedAt: number | undefined
  pairingRevision: number | undefined
  // An action with nothing of its own to send rests on the outcome of what was queued before it.
  dependsOn: FolderNoteAction[]
  /** Resolves once with whether the action took effect (true) or was reported not saved. */
  outcome: Promise<boolean>
  resolveOutcome: (saved: boolean) => void
  // Enqueued while the protected backlog was full: refused without a write.
  overflow?: boolean
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

/** Builds an action from the lists the user acted on; its delta is fixed from now on. */
export function createFolderNoteAction(
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
  let resolveOutcome: (saved: boolean) => void = () => {}
  const outcome = new Promise<boolean>((resolve) => {
    resolveOutcome = resolve
  })
  const queued = unsettledByCopy.get(copyKey) ?? []
  const action: FolderNoteAction = {
    seq: nextFolderNoteSeq(),
    delta,
    before,
    expectedCreatedAt: ownedFolderRow(get(), owner)?.createdAt,
    pairingRevision: owner.runtimeEnvironmentId
      ? getRuntimeEnvironmentRevision(owner.runtimeEnvironmentId)
      : undefined,
    dependsOn: delta.size === 0 ? [...queued] : [],
    outcome,
    resolveOutcome
  }
  unsettledByCopy.set(copyKey, [...queued, action])
  return action
}

export function unsettledFolderNoteActions(copyKey: string): readonly FolderNoteAction[] {
  return unsettledByCopy.get(copyKey) ?? []
}

/** Retires an action from the queue bookkeeping and reports its outcome to anything waiting on it. */
export function settleFolderNoteAction(
  copyKey: string,
  action: FolderNoteAction,
  saved: boolean
): void {
  const remaining = (unsettledByCopy.get(copyKey) ?? []).filter((entry) => entry !== action)
  if (remaining.length === 0) {
    unsettledByCopy.delete(copyKey)
  } else {
    unsettledByCopy.set(copyKey, remaining)
  }
  action.resolveOutcome(saved)
}

/**
 * Whether every queued action touching a note `matches` selects took effect, once they settle.
 * A same-value edit or an apparently empty clear can only look like a no-op because of them.
 */
export async function awaitFolderNoteActionsTouching(
  copyKey: string,
  matches: (id: string, note: DiffComment | undefined) => boolean
): Promise<boolean> {
  const touching = (unsettledByCopy.get(copyKey) ?? []).filter((action) =>
    [...action.delta].some(
      ([id, after]) => matches(id, after) || matches(id, action.before.get(id))
    )
  )
  const outcomes = await Promise.all(touching.map((action) => action.outcome))
  return outcomes.every(Boolean)
}

/**
 * The base list with each unsettled action applied in call order, the way the host applies them:
 * an edit stays in place, an add or a re-add after a delete goes last. O(notes + delta entries).
 */
export function overlayFolderNotes(
  base: readonly DiffComment[],
  pending: readonly FolderNoteAction[]
): DiffComment[] {
  if (pending.every((action) => action.delta.size === 0)) {
    return [...base]
  }
  const inBase = new Set(base.map((note) => note.id))
  // id → its final version, and its append position when it is no longer where the base had it.
  const changed = new Map<string, { note: DiffComment | undefined; appended: number | null }>()
  let appendSeq = 0
  for (const action of pending) {
    for (const [id, note] of action.delta) {
      const prior = changed.get(id)
      const present = prior ? prior.note !== undefined : inBase.has(id)
      if (!note) {
        changed.set(id, { note: undefined, appended: null })
      } else if (present) {
        changed.set(id, { note, appended: prior?.appended ?? null })
      } else {
        appendSeq += 1
        changed.set(id, { note, appended: appendSeq })
      }
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
  const appended = [...changed.values()].filter(
    (change): change is { note: DiffComment; appended: number } =>
      change.note !== undefined && change.appended !== null
  )
  appended.sort((a, b) => a.appended - b.appended)
  for (const change of appended) {
    result.push(change.note)
  }
  return result
}

export function resetFolderNoteActionsForTests(): void {
  unsettledByCopy.clear()
}
