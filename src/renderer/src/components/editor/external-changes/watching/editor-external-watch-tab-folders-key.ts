import type { AppState } from '@/store/types'
import { parentDirForWatchPath } from '@/components/right-sidebar/file-explorer/watching/file-explorer-watch-path'
import { isVirtualEditorFile } from '@/store/slices/editor/tabs/editor-tab-content-type'
import { relativePathInsideRoot } from '../../../../../../shared/file-access/cross-platform-path'
import {
  getEditorExternalWatchTargetKey,
  getOpenFileRuntimeOwner,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'

let cachedOpenFiles: AppState['openFiles'] | null = null
let cachedTargets: readonly EditorExternalWatchTarget[] | null = null
let cachedKey = '[]'

/** Stable key of (local target, tab folder below its root) pairs, so edits to tab content don't re-run the sync. */
export function selectLocalTabFoldersKey(
  openFiles: AppState['openFiles'],
  targets: readonly EditorExternalWatchTarget[]
): string {
  if (openFiles === cachedOpenFiles && targets === cachedTargets) {
    return cachedKey
  }
  const localTargetsById = new Map<string, EditorExternalWatchTarget[]>()
  for (const target of targets) {
    // Why: SSH and runtime workspaces watch through their host, not this renderer's local watcher.
    if (target.runtimeEnvironmentId === null && target.connectionId === undefined) {
      localTargetsById.set(target.worktreeId, [
        ...(localTargetsById.get(target.worktreeId) ?? []),
        target
      ])
    }
  }
  const entries = new Set<string>()
  for (const file of openFiles) {
    const fileTargets = localTargetsById.get(file.worktreeId)
    if (!fileTargets || getOpenFileRuntimeOwner(file) !== null || isVirtualEditorFile(file)) {
      continue
    }
    // Why not dirname: a POSIX name may contain a backslash.
    const folder = parentDirForWatchPath(file.filePath)
    for (const target of fileTargets) {
      if (relativePathInsideRoot(target.worktreePath, folder)) {
        // Why JSON: paths may contain any delimiter a joined string could use.
        entries.add(JSON.stringify([getEditorExternalWatchTargetKey(target), folder]))
      }
    }
  }
  cachedOpenFiles = openFiles
  cachedTargets = targets
  cachedKey = JSON.stringify([...entries].sort())
  return cachedKey
}
