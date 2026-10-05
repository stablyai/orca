import type { OpenFile } from '@/store/slices/editor'
import { parentDirForWatchPath } from '@/components/right-sidebar/file-explorer-watch-path'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../shared/cross-platform-path'
import { isWslUncPath } from '../../../shared/wsl-paths'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'
import {
  getEditorExternalWatchTargetKey,
  getOpenFileRuntimeOwner
} from './editor-external-watch-target-identity'

export function appendLocalDocumentDirectoryWatchTargets(
  openFiles: OpenFile[],
  targets: EditorExternalWatchTarget[],
  localOwners: ReadonlySet<string>
): void {
  const rootsByOwner = new Map<string, string[]>()
  for (const target of targets) {
    if (target.runtimeEnvironmentId === null && !target.connectionId) {
      const roots = rootsByOwner.get(target.worktreeId) ?? []
      roots.push(target.worktreePath)
      rootsByOwner.set(target.worktreeId, roots)
    }
  }
  const directories = new Map<string, EditorExternalWatchTarget>()
  for (const file of openFiles) {
    if (
      !localOwners.has(file.worktreeId) ||
      getOpenFileRuntimeOwner(file) !== null ||
      file.externalSshTargetId ||
      file.isUntitled ||
      (file.mode !== 'edit' && file.mode !== 'markdown-preview') ||
      (!file.filePath.startsWith('/') && !isWindowsAbsolutePathLike(file.filePath)) ||
      isWslUncPath(file.filePath) ||
      rootsByOwner
        .get(file.worktreeId)
        ?.some((root) => relativePathInsideRoot(root, file.filePath) !== null)
    ) {
      continue
    }
    const target: EditorExternalWatchTarget = {
      worktreeId: file.worktreeId,
      worktreePath: parentDirForWatchPath(file.filePath),
      connectionId: undefined,
      runtimeEnvironmentId: null,
      shallow: true
    }
    directories.set(getEditorExternalWatchTargetKey(target), target)
  }
  targets.push(
    ...[...directories.values()].sort((left, right) =>
      normalizeRuntimePathForComparison(left.worktreePath).localeCompare(
        normalizeRuntimePathForComparison(right.worktreePath)
      )
    )
  )
}
