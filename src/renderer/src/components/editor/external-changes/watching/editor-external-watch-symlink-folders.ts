import { normalizeRuntimePathForComparison } from '../../../../../../shared/file-access/cross-platform-path'
import { isWslUncPath } from '../../../../../../shared/file-access/wsl-paths'
import {
  getEditorExternalWatchTargetKey,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'
import type { HeldWatchRoots } from './editor-external-watch-local-roots'
import { SymlinkWatchPlan, type SymlinkTabFolder } from './editor-external-watch-symlink-plan'

// Why: native recursive watches don't follow a symlinked folder, so a tab reached through one needs a watch on its own folder.

// Why: a preview-tab swap closes and reopens a folder within seconds; keeping it open for main's own watcher-reuse window
// (WATCHER_TEARDOWN_GRACE_MS) turns that swap's 2N+2 watch requests into none. Only folders another one could share apply.
const CLOSED_FOLDER_GRACE_MS = 30_000

/** Holds the watches open tab folders behind a symlink need, keeping the plan in step with which tab folders are open. */
export class SymlinkedTabFolderWatches {
  private readonly folders = new Map<string, SymlinkTabFolder>()
  /** Open tab folders per comparison path, behind a link or not; 0 while a closed one waits out its grace. */
  private readonly openPaths = new Map<string, number>()
  private readonly closing = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly plan: SymlinkWatchPlan

  constructor(onWatchError: (target: EditorExternalWatchTarget, error: unknown) => void) {
    this.plan = new SymlinkWatchPlan(
      (key) => this.openPaths.has(key),
      onWatchError,
      (key) => this.stopGrace(key)
    )
  }

  sync(
    foldersKey: string,
    targets: readonly EditorExternalWatchTarget[],
    heldWatchRoots: HeldWatchRoots
  ): void {
    const nextKeys: string[] = JSON.parse(foldersKey)
    const nextKeySet = new Set(nextKeys)
    // Why unlink every closed folder first: closing a parent with its children must not plan watches for the children.
    const closed = [...this.folders].filter(([key]) => !nextKeySet.has(key))
    for (const [, folder] of closed) {
      folder.leaving = true
    }
    for (const [key, folder] of closed) {
      this.folders.delete(key)
      this.plan.unlink(folder, heldWatchRoots)
    }
    for (const [, folder] of closed) {
      this.countOpen(folder.key, -1, heldWatchRoots)
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
      const folder: SymlinkTabFolder = {
        target,
        targetKey,
        path: folderPath,
        key: normalizeRuntimePathForComparison(folderPath),
        candidates: undefined,
        desired: undefined,
        covered: false,
        leaving: false,
        pinnedTo: undefined
      }
      this.folders.set(key, folder)
      this.countOpen(folder.key, 1, heldWatchRoots)
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
          if (link && this.folders.get(key) === folder) {
            this.plan.link(folder, link, heldWatchRoots)
          }
        })
    }
  }

  /** Workspaces whose tabs a payload from one of these folder watches belongs to. */
  targetsFor(worktreePath: string, connectionId: string | undefined): EditorExternalWatchTarget[] {
    if (connectionId || !this.plan.hasRoots()) {
      return []
    }
    return this.plan.targetsFor(normalizeRuntimePathForComparison(worktreePath))
  }

  /** A shared watch's status may have changed (main resynced it, or another consumer retried it); re-check what it sees. */
  noteSettled(worktreePath: string, heldWatchRoots: HeldWatchRoots): void {
    this.plan.replanSeenBy(normalizeRuntimePathForComparison(worktreePath), heldWatchRoots)
  }

  /** Forgets every folder; the caller releases the held roots. */
  clear(): void {
    for (const timer of this.closing.values()) {
      clearTimeout(timer)
    }
    this.closing.clear()
    this.folders.clear()
    this.openPaths.clear()
    this.plan.clear()
  }

  private countOpen(key: string, delta: number, heldWatchRoots: HeldWatchRoots): void {
    const count = (this.openPaths.get(key) ?? 0) + delta
    const reopened = this.closing.get(key)
    if (reopened && count > 0) {
      clearTimeout(reopened)
      this.closing.delete(key)
      this.openPaths.set(key, count)
      return
    }
    if (count > 0) {
      this.openPaths.set(key, count)
      if (count === delta) {
        this.plan.replanFor(key, true, heldWatchRoots)
      }
      return
    }
    // Why only a chosen folder: closing one nobody chose changes no watch, so it needs no grace.
    if (!this.plan.isWanted(key)) {
      this.forgetOpen(key)
      return
    }
    this.openPaths.set(key, 0)
    this.closing.set(
      key,
      setTimeout(() => {
        this.closing.delete(key)
        this.forgetOpen(key)
        this.plan.replanFor(key, false, heldWatchRoots)
      }, CLOSED_FOLDER_GRACE_MS)
    )
  }

  /** Nothing wants this closed folder's watch any more, so its grace has nothing to keep. */
  private stopGrace(key: string): void {
    const timer = this.closing.get(key)
    if (timer) {
      clearTimeout(timer)
      this.closing.delete(key)
      this.forgetOpen(key)
    }
  }

  private forgetOpen(key: string): void {
    this.openPaths.delete(key)
    this.plan.forgetFailure(key)
  }
}
