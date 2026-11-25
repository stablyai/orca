import type { AppState } from '@/store/types'
import { parentDirForWatchPath } from '@/components/right-sidebar/file-explorer/watching/file-explorer-watch-path'
import { isVirtualEditorFile } from '@/store/slices/editor/tabs/editor-tab-content-type'
import {
  isCaseInsensitiveRuntimeRoot,
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../../../../shared/file-access/cross-platform-path'
import { isWslUncPath } from '../../../../../../shared/file-access/wsl-paths'
import { WATCHER_IGNORE_DIRS } from '../../../../../../shared/file-watch/watcher-ignore-dirs'
import {
  getEditorExternalWatchTargetKey,
  getOpenFileRuntimeOwner,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'
import {
  acquireWatchRoot,
  isWatchRootFailed,
  releaseWatchRoot,
  retryFailedWatchRoot,
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

type TabFolder = {
  target: EditorExternalWatchTarget
  targetKey: string
  path: string
  /** Deepest link on the way from the workspace root, once main has answered. */
  link: string | undefined
  watch: FolderWatch | undefined
}

type FolderWatch = {
  path: string
  folders: Set<TabFolder>
  /** Workspaces this watch reports for, by target key, counted per covered folder. */
  targets: Map<string, { target: EditorExternalWatchTarget; folders: number }>
}

/** Holds one watch per linked tab folder that no watched folder behind the same link already covers. */
export class SymlinkedTabFolderWatches {
  private readonly folders = new Map<string, TabFolder>()
  /** Watches by comparison path. */
  private readonly watches = new Map<string, FolderWatch>()

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
        this.leaveWatch(folder, heldWatchRoots)
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
        targetKey,
        path: folderPath,
        link: undefined,
        watch: undefined
      }
      this.folders.set(key, folder)
      void window.api.fs
        .findDeepestSymlinkBelowRoot({ rootPath: target.worktreePath, path: folderPath })
        .catch(() => null)
        .then((link) => {
          // Why: the tab may have closed, or the hook unmounted, while main answered.
          if (link && this.folders.get(key) === folder) {
            this.joinWatch(folder, link, heldWatchRoots)
          }
        })
    }
  }

  /** Workspaces whose tabs a payload from one of these folder watches belongs to. */
  targetsFor(worktreePath: string, connectionId: string | undefined): EditorExternalWatchTarget[] {
    if (connectionId || this.watches.size === 0) {
      return []
    }
    const watch = this.watches.get(normalizeRuntimePathForComparison(worktreePath))
    return watch ? [...watch.targets.values()].map((entry) => entry.target) : []
  }

  /** Forgets every folder; the caller releases the held roots. */
  clear(): void {
    this.folders.clear()
    this.watches.clear()
  }

  // Why never swap a working watch for a new outer one: releasing it drops its queued events, and the new one may fail.
  private joinWatch(
    folder: TabFolder,
    link: string,
    heldWatchRoots: HeldWatchRoots,
    ownPathOnly = false
  ): void {
    folder.link = link
    // Why own path only after a failure: re-homed folders skip sharing, so an outage costs one move per folder.
    const plan = ownPathOnly
      ? {
          watch: this.watches.get(normalizeRuntimePathForComparison(folder.path)),
          startAt: folder.path
        }
      : this.planWatch(folder, link, heldWatchRoots)
    // Why: only a folder's own-path watch is returned failed; joining it retries it, as a fresh request would.
    if (plan.watch && isWatchRootFailed(heldWatchRoots, toWatchRoot(plan.watch.path))) {
      const failed = plan.watch
      retryFailedWatchRoot(heldWatchRoots, toWatchRoot(failed.path), (error) =>
        this.watchFailed(failed, folder.target, error, heldWatchRoots)
      )
    }
    const watch = plan.watch ?? this.startWatch(plan.startAt, folder.target, heldWatchRoots)
    folder.watch = watch
    watch.folders.add(folder)
    const entry = watch.targets.get(folder.targetKey)
    if (entry) {
      entry.folders += 1
      entry.target = folder.target
    } else {
      watch.targets.set(folder.targetKey, { target: folder.target, folders: 1 })
    }
  }

  private leaveWatch(folder: TabFolder, heldWatchRoots: HeldWatchRoots): void {
    const watch = folder.watch
    if (!watch) {
      return
    }
    folder.watch = undefined
    watch.folders.delete(folder)
    const entry = watch.targets.get(folder.targetKey)
    if (entry && --entry.folders === 0) {
      watch.targets.delete(folder.targetKey)
    }
    // Why: a watch stays while it covers any open folder, so closing the outer tab re-watches nothing.
    if (watch.folders.size === 0) {
      this.watches.delete(normalizeRuntimePathForComparison(watch.path))
      releaseWatchRoot(heldWatchRoots, toWatchRoot(watch.path))
    }
  }

  /**
   * The outermost working watch that sees `folder`, else where to start one: at the outermost open tab folder
   * between the link and `folder`. That folder shares the link, so it joins the watch whenever its own probe answers.
   */
  private planWatch(
    folder: TabFolder,
    link: string,
    heldWatchRoots: HeldWatchRoots
  ): { watch?: FolderWatch; startAt: string } {
    const windowsSyntax = isWindowsAbsolutePathLike(folder.path)
    // Why by syntax: a backslash is a filename character on POSIX.
    const path = folder.path.replace(windowsSyntax ? /[\\/]+$/ : /\/+$/, '')
    const relative = relativePathInsideRoot(link, path)
    // Why WSL: its watcher polls two levels below the root instead of watching recursively, so a watch covers only its own folder.
    // Why the slash form: a Windows suffix comes back slash-separated while tab folders keep backslashes.
    const suffix = relative === null ? '' : path.slice(path.length - relative.length)
    if (
      relative === null ||
      isWslUncPath(path) ||
      (windowsSyntax ? suffix.replace(/\\/g, '/') : suffix) !== relative
    ) {
      return {
        watch: this.watches.get(normalizeRuntimePathForComparison(folder.path)),
        startAt: folder.path
      }
    }
    // Why the folder's own spelling: ancestors are looked up as open tab folder keys, which use it.
    const separator = windowsSyntax ? /[\\/]/ : /\//
    const linkEnd = path.length - relative.length
    const ancestors = [relative === '' ? path : path.slice(0, linkEnd - 1)]
    const names: string[] = []
    let start = linkEnd
    for (let index = linkEnd; relative !== '' && index <= path.length; index += 1) {
      if (index === path.length || separator.test(path[index])) {
        names.push(path.slice(start, index))
        ancestors.push(path.slice(0, index))
        start = index + 1
      }
    }
    // Why fold only there: the watcher's filter is case-sensitive, but a Windows tab may spell an ignored folder in another case.
    const foldCase = isCaseInsensitiveRuntimeRoot(link)
    const lastIgnored = names.findLastIndex((name) =>
      foldCase ? IGNORED_WATCH_DIRS_FOLDED.has(name.toLowerCase()) : IGNORED_WATCH_DIRS.has(name)
    )
    // Why past the last ignored folder: the watcher skips it, so a watch above it doesn't see this folder.
    let startAt: string | undefined
    for (let index = lastIgnored + 1; index < ancestors.length; index += 1) {
      const ancestor = ancestors[index]
      const watch = this.watches.get(normalizeRuntimePathForComparison(ancestor))
      // Why: a failed outer watch reports nothing, so a nested folder starts its own; the folder's own path is shared as-is.
      const working = watch && !isWatchRootFailed(heldWatchRoots, toWatchRoot(watch.path))
      if (watch && (working || index === ancestors.length - 1)) {
        return { watch, startAt: ancestor }
      }
      // Why not where a failed watch sits: starting there would orphan the folders that hold it.
      startAt ??=
        !watch && this.folders.has(JSON.stringify([folder.targetKey, ancestor]))
          ? ancestor
          : undefined
    }
    return { startAt: startAt ?? folder.path }
  }

  private startWatch(
    path: string,
    owner: EditorExternalWatchTarget,
    heldWatchRoots: HeldWatchRoots
  ): FolderWatch {
    const watch: FolderWatch = { path, folders: new Set(), targets: new Map() }
    this.watches.set(normalizeRuntimePathForComparison(path), watch)
    void acquireWatchRoot(heldWatchRoots, toWatchRoot(path), (error) =>
      this.watchFailed(watch, owner, error, heldWatchRoots)
    )
    return watch
  }

  /** Why: nested folders joined it while it was pending; each moves to a watch at its own path. */
  private watchFailed(
    watch: FolderWatch,
    owner: EditorExternalWatchTarget,
    error: unknown,
    heldWatchRoots: HeldWatchRoots
  ): void {
    this.onWatchError(owner, error)
    const path = normalizeRuntimePathForComparison(watch.path)
    if (this.watches.get(path) !== watch) {
      return
    }
    // Why safe: deleting the visited entry while iterating a Set is defined, and a moved folder never rejoins this watch.
    for (const folder of watch.folders) {
      if (folder.link && normalizeRuntimePathForComparison(folder.path) !== path) {
        this.leaveWatch(folder, heldWatchRoots)
        this.joinWatch(folder, folder.link, heldWatchRoots, true)
      }
    }
  }
}

function toWatchRoot(path: string): WatchRootArgs {
  return { worktreePath: path, connectionId: undefined }
}

// Why the Library names: a macOS watch rooted above ~/Library skips it and its app containers (macos-protected-watch-exclusions).
const IGNORED_WATCH_DIRS = new Set([
  ...WATCHER_IGNORE_DIRS,
  'Library',
  'Containers',
  'Group Containers'
])
const IGNORED_WATCH_DIRS_FOLDED = new Set([...IGNORED_WATCH_DIRS].map((name) => name.toLowerCase()))
