import type { EditorExternalWatchTarget } from './editor-external-watch-targets'
import type { WatchRootArgs } from './editor-external-watch-local-roots'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/file-access/cross-platform-path'

export type TabFolder = {
  target: EditorExternalWatchTarget
  targetKey: string
  path: string
  /** Deepest link on the way from the workspace root, once main has answered. */
  link: string | undefined
  watch: FolderWatch | undefined
}

export type FolderWatch = {
  path: string
  folders: Set<TabFolder>
  /** Workspaces this watch reports for, by target key, counted per covered folder. */
  targets: Map<string, { target: EditorExternalWatchTarget; folders: number }>
  /** Open folders at this watch's own path; at zero, it narrows to the folders it still covers. */
  ownFolders: number
  narrowTimer: ReturnType<typeof setTimeout> | undefined
}

export function attachFolder(folder: TabFolder, watch: FolderWatch): void {
  folder.watch = watch
  watch.folders.add(folder)
  if (isSamePath(folder.path, watch.path)) {
    watch.ownFolders += 1
  }
  const entry = watch.targets.get(folder.targetKey)
  if (entry) {
    entry.folders += 1
    entry.target = folder.target
  } else {
    watch.targets.set(folder.targetKey, { target: folder.target, folders: 1 })
  }
}

export function detachFolder(folder: TabFolder, watch: FolderWatch): void {
  folder.watch = undefined
  watch.folders.delete(folder)
  if (isSamePath(folder.path, watch.path)) {
    watch.ownFolders -= 1
  }
  const entry = watch.targets.get(folder.targetKey)
  if (entry && --entry.folders === 0) {
    watch.targets.delete(folder.targetKey)
  }
}

export function isSamePath(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

export function toWatchRoot(path: string): WatchRootArgs {
  return { worktreePath: path, connectionId: undefined }
}
