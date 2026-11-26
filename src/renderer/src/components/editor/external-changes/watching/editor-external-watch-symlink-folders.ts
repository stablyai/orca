import { normalizeRuntimePathForComparison } from '../../../../../../shared/file-access/cross-platform-path'
import { isWslUncPath } from '../../../../../../shared/file-access/wsl-paths'
import { WATCH_BATCH_INTERVAL_MS } from '../../../../../../shared/file-watch/filesystem-watch-batch-window'
import { coveringAncestors } from './editor-external-watch-symlink-coverage'
import {
  getEditorExternalWatchTargetKey,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'
import {
  attachFolder,
  detachFolder,
  isSamePath,
  toWatchRoot,
  type FolderWatch,
  type TabFolder
} from './editor-external-watch-folder-watch'
import {
  acquireWatchRoot,
  isWatchRootFailed,
  releaseWatchRoot,
  retryFailedWatchRoot,
  watchRootInstalled,
  type HeldWatchRoots
} from './editor-external-watch-local-roots'

// Why: native recursive watches don't follow a symlinked folder, so a tab reached through one needs a watch on its own folder.

// Why a grace like main's root teardown: a preview tab swap or quick reopen of the outer folder keeps its watch.
const NARROW_GRACE_MS = 30_000
// Why: main drops a released root's unflushed batch, so the outer watch keeps reporting for many batch ticks after the handoff.
const HANDOFF_DRAIN_MS = WATCH_BATCH_INTERVAL_MS * 10

/** Holds one watch per linked tab folder that no watched folder behind the same link already covers. */
export class SymlinkedTabFolderWatches {
  private readonly folders = new Map<string, TabFolder>()
  /** Watches by comparison path. */
  private readonly watches = new Map<string, FolderWatch>()
  /** Narrowed watches still reporting until their drain ends, with the routes they had, by comparison path. */
  private readonly retiring = new Map<
    string,
    { watch: FolderWatch; targets: FolderWatch['targets'] }
  >()
  private generation = 0

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
      // Why now: a reopened folder that already has a watch on its path cancels that watch's narrowing before main answers.
      const ownWatch = this.watches.get(normalizeRuntimePathForComparison(folderPath))
      if (ownWatch) {
        this.retryIfFailed(ownWatch, target, heldWatchRoots)
        attachFolder(folder, ownWatch)
        this.updateNarrowing(ownWatch, heldWatchRoots)
      }
      void window.api.fs
        .findSymlinkBelowRoot({
          rootPath: target.worktreePath,
          path: folderPath,
          // Why: a WSL folder is never shared, so whether a link exists is all it needs.
          which: isWslUncPath(folderPath) ? 'first' : 'deepest'
        })
        .catch(() => null)
        .then((link) => {
          // Why: the tab may have closed, or the hook unmounted, while main answered.
          if (this.folders.get(key) !== folder) {
            return
          }
          // Why: a folder attached early but not behind a link is already seen by its workspace's own root watch.
          if (!link) {
            this.leaveWatch(folder, heldWatchRoots)
            return
          }
          if (folder.watch) {
            folder.link = link
          } else {
            this.joinWatch(folder, link, heldWatchRoots)
          }
        })
    }
  }

  /** Workspaces whose tabs a payload from one of these folder watches belongs to. */
  targetsFor(worktreePath: string, connectionId: string | undefined): EditorExternalWatchTarget[] {
    if (connectionId || (this.watches.size === 0 && this.retiring.size === 0)) {
      return []
    }
    const path = normalizeRuntimePathForComparison(worktreePath)
    const retiring = this.retiring.get(path)
    if (!retiring) {
      const watch = this.watches.get(path)
      return watch ? [...watch.targets.values()].map((entry) => entry.target) : []
    }
    const targets = new Map(this.watches.get(path)?.targets)
    for (const [key, entry] of retiring.targets) {
      targets.set(key, entry)
    }
    return [...targets.values()].map((entry) => entry.target)
  }

  /** Forgets every folder; the caller releases the held roots. */
  clear(): void {
    this.generation += 1
    for (const watch of this.watches.values()) {
      clearTimeout(watch.narrowTimer)
    }
    this.folders.clear()
    this.watches.clear()
    this.retiring.clear()
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
    if (plan.watch) {
      this.retryIfFailed(plan.watch, folder.target, heldWatchRoots)
    }
    const watch = plan.watch ?? this.startWatch(plan.startAt, folder.target, heldWatchRoots).watch
    attachFolder(folder, watch)
    this.updateNarrowing(watch, heldWatchRoots)
  }

  private leaveWatch(folder: TabFolder, heldWatchRoots: HeldWatchRoots): void {
    const watch = folder.watch
    if (!watch) {
      return
    }
    detachFolder(folder, watch)
    if (watch.folders.size === 0) {
      clearTimeout(watch.narrowTimer)
      this.watches.delete(normalizeRuntimePathForComparison(watch.path))
      releaseWatchRoot(heldWatchRoots, toWatchRoot(watch.path))
      return
    }
    this.updateNarrowing(watch, heldWatchRoots)
  }

  /** Why: once no open tab sits in a watch's own folder, its siblings' changes serve nothing, so it narrows after a grace. */
  private updateNarrowing(watch: FolderWatch, heldWatchRoots: HeldWatchRoots): void {
    if (watch.ownFolders > 0) {
      clearTimeout(watch.narrowTimer)
      watch.narrowTimer = undefined
    } else if (!watch.narrowTimer) {
      watch.narrowTimer = setTimeout(() => this.narrow(watch, heldWatchRoots), NARROW_GRACE_MS)
    }
  }

  /** Moves the folders a watch still covers to watches on the outermost of them, and retires it once those report. */
  private narrow(watch: FolderWatch, heldWatchRoots: HeldWatchRoots): void {
    watch.narrowTimer = undefined
    const path = normalizeRuntimePathForComparison(watch.path)
    if (this.watches.get(path) !== watch || watch.ownFolders > 0) {
      return
    }
    // Why a copy: moving folders empties the watch's routes, but its last batches still need them during the drain.
    const routes = new Map([...watch.targets].map(([key, entry]) => [key, { ...entry }]))
    const installs: Promise<void>[] = []
    const byDepth = [...watch.folders].sort((a, b) => a.path.length - b.path.length)
    for (const folder of byDepth) {
      let home: FolderWatch | undefined
      for (const ancestor of coveringAncestors(folder.path, watch.path) ?? [folder.path]) {
        const candidate = this.watches.get(normalizeRuntimePathForComparison(ancestor))
        const working = candidate && !isWatchRootFailed(heldWatchRoots, toWatchRoot(candidate.path))
        // Why the own path even when failed: starting another watch there would orphan the folders holding it.
        if (
          candidate &&
          candidate !== watch &&
          (working || isSamePath(candidate.path, folder.path))
        ) {
          home = candidate
          break
        }
      }
      if (home) {
        this.retryIfFailed(home, folder.target, heldWatchRoots)
      } else {
        home = this.startWatch(folder.path, folder.target, heldWatchRoots).watch
      }
      // Why every home: a reused one may still be installing or retrying, and the outer watch reports until it does.
      installs.push(watchRootInstalled(heldWatchRoots, toWatchRoot(home.path)))
      detachFolder(folder, watch)
      attachFolder(folder, home)
      this.updateNarrowing(home, heldWatchRoots)
    }
    // Why move first and release later: nothing can join or re-narrow a retiring watch, and it reports until its replacements do.
    this.watches.delete(path)
    const entry = { watch, targets: routes }
    this.retiring.set(path, entry)
    const generation = this.generation
    void Promise.all(installs)
      .then(() => new Promise((resolve) => setTimeout(resolve, HANDOFF_DRAIN_MS)))
      .then(() => {
        if (generation !== this.generation) {
          return
        }
        if (this.retiring.get(path) === entry) {
          this.retiring.delete(path)
        }
        releaseWatchRoot(heldWatchRoots, toWatchRoot(watch.path))
      })
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
    const ancestors = coveringAncestors(folder.path, link)
    if (!ancestors) {
      return {
        watch: this.watches.get(normalizeRuntimePathForComparison(folder.path)),
        startAt: folder.path
      }
    }
    let startAt: string | undefined
    for (const [index, ancestor] of ancestors.entries()) {
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

  private retryIfFailed(
    watch: FolderWatch,
    owner: EditorExternalWatchTarget,
    heldWatchRoots: HeldWatchRoots
  ): void {
    if (isWatchRootFailed(heldWatchRoots, toWatchRoot(watch.path))) {
      retryFailedWatchRoot(heldWatchRoots, toWatchRoot(watch.path), (error) =>
        this.watchFailed(watch, owner, error, heldWatchRoots)
      )
    }
  }

  private startWatch(
    path: string,
    owner: EditorExternalWatchTarget,
    heldWatchRoots: HeldWatchRoots
  ): { watch: FolderWatch; installed: Promise<void> } {
    const watch: FolderWatch = {
      path,
      folders: new Set(),
      targets: new Map(),
      ownFolders: 0,
      narrowTimer: undefined
    }
    this.watches.set(normalizeRuntimePathForComparison(path), watch)
    const installed = acquireWatchRoot(heldWatchRoots, toWatchRoot(path), (error) =>
      this.watchFailed(watch, owner, error, heldWatchRoots)
    )
    return { watch, installed }
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
      if (folder.link && !isSamePath(folder.path, watch.path)) {
        this.leaveWatch(folder, heldWatchRoots)
        this.joinWatch(folder, folder.link, heldWatchRoots, true)
      }
    }
  }
}
