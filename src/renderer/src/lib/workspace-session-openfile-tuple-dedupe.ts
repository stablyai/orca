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
export function dedupeOpenFilesByOwnerTuple(files: readonly OpenFile[]): OpenFile[] {
  const seen = new Set<string>()
  const result: OpenFile[] = []
  for (const file of files) {
    const key = JSON.stringify([
      file.filePath,
      file.worktreeId,
      runtimeOwnerKey(file.runtimeEnvironmentId)
    ])
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(file)
  }
  return result
}
