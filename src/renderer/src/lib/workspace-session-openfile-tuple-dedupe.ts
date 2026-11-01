import type { OpenFile } from '../store/slices/editor'
import { runtimeOwnerKey } from '../store/slices/editor/file-ids/editor-file-ids'

/**
 * Why (issue #23967): the session mirror keys local files by their raw path while hydration
 * recasts every persisted row to an owned id, so the mirror's raw-path lookup misses and it
 * re-appends a (path, worktree, runtime) row on each launch. Hydration already folds that
 * repeat — it keeps the first record per owner and treats further repeats as corruption
 * (#17370) — so persisting one row per tuple is lossless for restore while stopping
 * orca-data.json from accumulating dead rows. First occurrence wins to keep the persisted
 * order stable; rows owned by a different runtime environment are distinct files here and
 * are never folded (cross-environment identity is a separate, unsolved problem).
 */
export type OwnerTupleFold = {
  files: OpenFile[]
  /**
   * Why: worktree state (the active-file pointer) is keyed by the removed row's id, so callers
   * need the fold's removed→retained mapping to re-point it at the row that survived. Scoped
   * per worktree because a raw-path id is just the absolute path string, which other worktrees
   * can carry as a live row — a fold in one worktree must never re-point those.
   */
  retainedIdByRemovedId: ReadonlyMap<string, ReadonlyMap<string, string>>
}

export function foldOpenFilesByOwnerTuple(files: readonly OpenFile[]): OwnerTupleFold {
  const retainedIdByTupleKey = new Map<string, string>()
  const result: OpenFile[] = []
  const retainedIdByRemovedId = new Map<string, Map<string, string>>()
  for (const file of files) {
    const key = JSON.stringify([
      file.filePath,
      file.worktreeId,
      runtimeOwnerKey(file.runtimeEnvironmentId)
    ])
    const retainedId = retainedIdByTupleKey.get(key)
    if (retainedId !== undefined) {
      // A tuple can never span worktrees, so each removed id maps inside its own worktree only.
      let removedIdsInWorktree = retainedIdByRemovedId.get(file.worktreeId)
      if (!removedIdsInWorktree) {
        removedIdsInWorktree = new Map()
        retainedIdByRemovedId.set(file.worktreeId, removedIdsInWorktree)
      }
      removedIdsInWorktree.set(file.id, retainedId)
      continue
    }
    retainedIdByTupleKey.set(key, file.id)
    result.push(file)
  }
  return { files: result, retainedIdByRemovedId }
}

/**
 * Why: the folded duplicate may be the row an active-file pointer names; remap it to the retained
 * row so the selection — and the 'editor' tab-type marker gated on it — survives persistence.
 * Only remap when the id no longer names a retained row in that worktree: the same raw-path id
 * can also be a live row here or in another worktree, and that pointer must stay put.
 */
export function persistActiveFileIdByWorktree(
  activeFileIdByWorktree: Record<string, string | null>,
  editFileIdsByWorktree: Readonly<Record<string, ReadonlySet<string>>>,
  retainedIdByRemovedId: OwnerTupleFold['retainedIdByRemovedId']
): Record<string, string> {
  const activeFileEntries: [string, string][] = []
  for (const [worktreeId, fileId] of Object.entries(activeFileIdByWorktree)) {
    if (!fileId) {
      continue
    }
    const retainedFileId =
      editFileIdsByWorktree[worktreeId]?.has(fileId) === true
        ? fileId
        : (retainedIdByRemovedId.get(worktreeId)?.get(fileId) ?? fileId)
    if (editFileIdsByWorktree[worktreeId]?.has(retainedFileId) === true) {
      activeFileEntries.push([worktreeId, retainedFileId])
    }
  }
  return Object.fromEntries(activeFileEntries)
}
