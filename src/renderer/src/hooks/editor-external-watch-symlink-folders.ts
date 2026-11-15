import type { AppState } from '@/store/types'
import { parentDirForWatchPath } from '@/components/right-sidebar/file-explorer/watching/file-explorer-watch-path'
import { isVirtualEditorFile } from '@/store/slices/editor/tabs/editor-tab-content-type'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../shared/cross-platform-path'
import {
  getEditorExternalWatchTargetKey,
  getOpenFileRuntimeOwner,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'
import {
  acquireWatchRoot,
  releaseWatchRoot,
  type HeldWatchRoots,
  type WatchRootArgs
} from './editor-external-watch-local-roots'

// Why: native recursive watches don't follow a symlinked folder, so a tab reached through one needs a watch on its own folder.

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

type TabFolder = { target: EditorExternalWatchTarget; watchRoot: WatchRootArgs }

/** Holds a watch on each open tab's folder that a symlink below the workspace root leads to. */
export class SymlinkedTabFolderWatches {
  private readonly folders = new Map<string, TabFolder>()
  private readonly watchedByPath = new Map<string, Set<TabFolder>>()

  constructor(
    private readonly onWatchError: (target: EditorExternalWatchTarget, error: unknown) => void
  ) {}

  sync(
    foldersKey: string,
    targets: readonly EditorExternalWatchTarget[],
    heldWatchRoots: HeldWatchRoots
  ): void {
    const nextKeys: string[] = JSON.parse(foldersKey)
    const nextKeySet = new Set(nextKeys)
    for (const [key, folder] of this.folders) {
      if (!nextKeySet.has(key)) {
        this.folders.delete(key)
        if (this.unmarkWatched(folder)) {
          releaseWatchRoot(heldWatchRoots, folder.watchRoot)
        }
      }
    }
    const targetsByKey = new Map(targets.map((t) => [getEditorExternalWatchTargetKey(t), t]))
    for (const key of nextKeys) {
      if (this.folders.has(key)) {
        continue
      }
      const [targetKey, folderPath]: [string, string] = JSON.parse(key)
      const target = targetsByKey.get(targetKey)
      if (!target) {
        continue
      }
      const folder: TabFolder = {
        target,
        watchRoot: { worktreePath: folderPath, connectionId: undefined }
      }
      this.folders.set(key, folder)
      void window.api.fs
        .hasSymlinkBelowRoot({ rootPath: target.worktreePath, path: folderPath })
        .catch(() => false)
        .then((isLinked) => {
          // Why: the tab may have closed, or the hook unmounted, while main answered.
          if (!isLinked || this.folders.get(key) !== folder) {
            return
          }
          this.markWatched(folder)
          void acquireWatchRoot(heldWatchRoots, folder.watchRoot, (error) =>
            this.onWatchError(target, error)
          )
        })
    }
  }

  /** Workspaces whose tabs a payload from one of these folder watches belongs to. */
  targetsFor(worktreePath: string, connectionId: string | undefined): EditorExternalWatchTarget[] {
    if (connectionId || this.watchedByPath.size === 0) {
      return []
    }
    const folders = this.watchedByPath.get(normalizeRuntimePathForComparison(worktreePath))
    return folders ? [...folders].map((folder) => folder.target) : []
  }

  /** Forgets every folder; the caller releases the held roots. */
  clear(): void {
    this.folders.clear()
    this.watchedByPath.clear()
  }

  private markWatched(folder: TabFolder): void {
    const path = normalizeRuntimePathForComparison(folder.watchRoot.worktreePath)
    this.watchedByPath.set(path, (this.watchedByPath.get(path) ?? new Set()).add(folder))
  }

  private unmarkWatched(folder: TabFolder): boolean {
    const path = normalizeRuntimePathForComparison(folder.watchRoot.worktreePath)
    const folders = this.watchedByPath.get(path)
    if (!folders?.delete(folder)) {
      return false
    }
    if (folders.size === 0) {
      this.watchedByPath.delete(path)
    }
    return true
  }
}
