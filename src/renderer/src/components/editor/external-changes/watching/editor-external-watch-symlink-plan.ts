import { normalizeRuntimePathForComparison } from '../../../../../../shared/file-access/cross-platform-path'
import { coveringAncestors } from './editor-external-watch-symlink-coverage'
import { bumpCounted, type Counted } from './editor-external-watch-counted-routes'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'
import {
  acquireWatchRoot,
  releaseWatchRoot,
  retryFailedWatchRoot,
  revalidateWatchRoot,
  watchRootStatus,
  type HeldWatchRoots,
  type WatchRootArgs
} from './editor-external-watch-local-roots'

type Candidate = { path: string; key: string }

export type SymlinkTabFolder = {
  target: EditorExternalWatchTarget
  targetKey: string
  path: string
  key: string
  /** Folders whose recursive watch reports changes here, outermost first, ending with this one; set once it's known to sit behind a link. */
  candidates: Candidate[] | undefined
  /** The watch this folder wants: its outermost open candidate that hasn't failed. */
  desired: string | undefined
  /** Whether a wanted watch that is working sees it. */
  covered: boolean
  /** Its tab closed: it wants nothing and counts as uncovered until its counts are removed. */
  leaving: boolean
  /** The outer watch it falls back on after its own watch failed. */
  pinnedTo: string | undefined
}

/**
 * Which watches linked tab folders need: per folder, the outermost open folder whose watch sees it. A watch is released
 * only once every folder it sees is seen by a working wanted one, so a failed successor keeps it. Each change touches
 * only the folders whose candidates include the changed path.
 */
export class SymlinkWatchPlan {
  /** Linked folders by each of their candidate paths. */
  private readonly seenBy = new Map<string, Set<SymlinkTabFolder>>()
  /** Per candidate path: the workspaces of the folders it sees. */
  private readonly routes = new Map<string, Map<string, Counted<EditorExternalWatchTarget>>>()
  /** Per candidate path: how many folders it sees no working wanted watch covers yet. */
  private readonly uncovered = new Map<string, number>()
  /** Wanted watches, with the folders that chose each. */
  private readonly desired = new Map<string, { path: string; folders: Set<SymlinkTabFolder> }>()
  /** Watches this instance holds one reference to, by comparison path. */
  private readonly roots = new Map<string, string>()
  /** Failed watches it let go of, so an open folder isn't re-requested on every change; forgotten when the folder closes. */
  private readonly failed = new Set<string>()
  /** Outer watches kept for folders whose own watch failed; the folders under them share them instead of doubling up. */
  private readonly pins = new Map<string, Set<SymlinkTabFolder>>()
  private generation = 0

  constructor(
    private readonly isOpen: (key: string) => boolean,
    private readonly onWatchError: (target: EditorExternalWatchTarget, error: unknown) => void,
    /** Called when no folder wants a watch on this path any more. */
    private readonly onUnwanted: (key: string) => void
  ) {}

  /** Workspaces whose tabs a payload from one of these folder watches belongs to. */
  targetsFor(key: string): EditorExternalWatchTarget[] {
    const targets = this.roots.has(key) ? this.routes.get(key) : undefined
    return targets ? [...targets.values()].map((entry) => entry.value) : []
  }

  hasRoots(): boolean {
    return this.roots.size > 0
  }

  /** Whether a folder chose this path's watch, so closing that folder changes a choice. */
  isWanted(key: string): boolean {
    return this.desired.has(key)
  }

  forgetFailure(key: string): void {
    this.failed.delete(key)
  }

  replanSeenBy(key: string, heldWatchRoots: HeldWatchRoots): void {
    if (this.roots.has(key)) {
      this.update(this.seenBy.get(key) ?? [], heldWatchRoots)
    }
  }

  /** Forgets everything; the caller releases the held roots. */
  clear(): void {
    this.generation += 1
    this.seenBy.clear()
    this.routes.clear()
    this.uncovered.clear()
    this.desired.clear()
    this.roots.clear()
    this.failed.clear()
    this.pins.clear()
  }

  /** Re-plans only folders whose choice this path can change: on open, unless a working outer folder already wins; on close, those that chose it. */
  replanFor(key: string, opened: boolean, heldWatchRoots: HeldWatchRoots): void {
    if (!opened) {
      this.update([...(this.desired.get(key)?.folders ?? [])], heldWatchRoots)
      return
    }
    const seen = this.seenBy.get(key)
    const [first] = seen ?? []
    if (!seen || !first) {
      return
    }
    // Why one folder is enough: every folder that sees this path shares its candidates above it (same link, same path).
    const above =
      first.candidates?.slice(
        0,
        first.candidates.findIndex((c) => c.key === key)
      ) ?? []
    if (above.some((c) => this.usable(c.key, false, heldWatchRoots))) {
      return
    }
    this.update(seen, heldWatchRoots)
  }

  link(folder: SymlinkTabFolder, link: string, heldWatchRoots: HeldWatchRoots): void {
    folder.candidates = (coveringAncestors(folder.path, link) ?? [folder.path]).map((path) => ({
      path,
      key: normalizeRuntimePathForComparison(path)
    }))
    for (const { key } of folder.candidates) {
      this.seenBy.set(key, (this.seenBy.get(key) ?? new Set()).add(folder))
      bumpCounted(this.routes, key, folder.targetKey, folder.target, 1)
      this.uncovered.set(key, (this.uncovered.get(key) ?? 0) + 1)
    }
    this.update([folder], heldWatchRoots)
  }

  unlink(folder: SymlinkTabFolder, heldWatchRoots: HeldWatchRoots): void {
    const candidates = folder.candidates
    if (!candidates) {
      return
    }
    folder.leaving = true
    // Why: dropping its want and coverage first lets folders sharing those watches re-check before its counts go.
    this.update([folder], heldWatchRoots)
    folder.candidates = undefined
    for (const { key } of candidates) {
      const seen = this.seenBy.get(key)
      seen?.delete(folder)
      bumpCounted(this.routes, key, folder.targetKey, folder.target, -1)
      if (seen?.size === 0) {
        this.seenBy.delete(key)
        this.uncovered.delete(key)
      } else {
        this.uncovered.set(key, (this.uncovered.get(key) ?? 0) - 1)
      }
      this.releaseIfUnneeded(key, heldWatchRoots)
    }
    const pin = folder.pinnedTo === undefined ? undefined : this.pins.get(folder.pinnedTo)
    if (folder.pinnedTo !== undefined && pin?.delete(folder) && pin.size === 0) {
      this.pins.delete(folder.pinnedTo)
      this.update(this.seenBy.get(folder.pinnedTo) ?? [], heldWatchRoots)
    }
    folder.pinnedTo = undefined
  }

  /** A watch a folder can choose: on an open (or pinned) folder, and not failed unless it is the folder's own. */
  private usable(key: string, own: boolean, heldWatchRoots: HeldWatchRoots): boolean {
    return (
      // Why held: a pin only stands in for an open folder while its watch is still kept.
      (this.isOpen(key) || (this.pins.has(key) && this.roots.has(key))) &&
      (own || this.status(key, heldWatchRoots) !== 'failed')
    )
  }

  private status(key: string, heldWatchRoots: HeldWatchRoots): string | undefined {
    const path = this.roots.get(key)
    if (path === undefined) {
      return this.failed.has(key) ? 'failed' : undefined
    }
    return watchRootStatus(heldWatchRoots, toWatchRoot(path))
  }

  /** Re-plans these folders, then the folders sharing any watch whose wanted state flipped, then releases what nothing needs. */
  private update(changed: Iterable<SymlinkTabFolder>, heldWatchRoots: HeldWatchRoots): void {
    const flipped = new Set<string>()
    const touched = new Set<SymlinkTabFolder>()
    for (const folder of changed) {
      touched.add(folder)
      this.chooseDesired(folder, flipped, heldWatchRoots)
    }
    for (const key of flipped) {
      for (const folder of this.seenBy.get(key) ?? []) {
        touched.add(folder)
      }
    }
    const keys = new Set(flipped)
    for (const folder of touched) {
      this.refreshCovered(folder, heldWatchRoots)
      for (const { key } of folder.candidates ?? []) {
        keys.add(key)
      }
    }
    for (const key of keys) {
      this.releaseIfUnneeded(key, heldWatchRoots)
    }
    const pinned: string[] = []
    for (const folder of touched) {
      const own = folder.desired === folder.key && !folder.pinnedTo && !folder.leaving
      if (!own || this.status(folder.key, heldWatchRoots) !== 'failed') {
        continue
      }
      // Why: its own watch failed, so the outer watch kept for it stays; its siblings share that one instead of doubling up.
      const fallback = folder.candidates?.find(
        (c) =>
          c.key !== folder.key &&
          this.roots.has(c.key) &&
          this.status(c.key, heldWatchRoots) === 'watching'
      )
      if (fallback) {
        folder.pinnedTo = fallback.key
        const pin = this.pins.get(fallback.key)
        if (pin) {
          pin.add(folder)
        } else {
          this.pins.set(fallback.key, new Set([folder]))
          pinned.push(fallback.key)
        }
      }
    }
    for (const key of pinned) {
      this.update(this.seenBy.get(key) ?? [], heldWatchRoots)
    }
  }

  private chooseDesired(
    folder: SymlinkTabFolder,
    flipped: Set<string>,
    heldWatchRoots: HeldWatchRoots
  ): void {
    const next = folder.leaving
      ? undefined
      : // Why own may be failed: a failed watch shares nothing, but stays wanted by its own folder so it isn't re-requested in a loop.
        folder.candidates?.find((c) => this.usable(c.key, c.key === folder.key, heldWatchRoots))
    if (next?.key === folder.desired) {
      return
    }
    const previous = folder.desired === undefined ? undefined : this.desired.get(folder.desired)
    if (
      folder.desired !== undefined &&
      previous?.folders.delete(folder) &&
      previous.folders.size === 0
    ) {
      this.desired.delete(folder.desired)
      flipped.add(folder.desired)
      this.onUnwanted(folder.desired)
    }
    folder.desired = next?.key
    if (!next) {
      return
    }
    const wanted = this.desired.get(next.key)
    if (wanted) {
      wanted.folders.add(folder)
      // Why: a folder joining a failed watch retries it, as a fresh request for that folder would.
      this.recheck(next.key, next.path, folder.target, false, heldWatchRoots)
      return
    }
    this.desired.set(next.key, { path: next.path, folders: new Set([folder]) })
    flipped.add(next.key)
    if (!this.roots.has(next.key)) {
      this.acquire(next.key, next.path, folder.target, heldWatchRoots)
    } else {
      // Why: a watch kept around may have failed or lost its native watcher since main answered; ask again before relying on it.
      this.recheck(next.key, next.path, folder.target, true, heldWatchRoots)
    }
  }

  /** Re-requests a held watch that failed (or, when asked, any settled one), then re-plans what it sees. */
  private recheck(
    key: string,
    path: string,
    owner: EditorExternalWatchTarget,
    evenIfWorking: boolean,
    heldWatchRoots: HeldWatchRoots
  ): void {
    const root = toWatchRoot(path)
    const onError = (error: unknown): void => this.onWatchError(owner, error)
    const asked =
      this.status(key, heldWatchRoots) === 'failed'
        ? retryFailedWatchRoot(heldWatchRoots, root, onError)
        : evenIfWorking
          ? revalidateWatchRoot(heldWatchRoots, root, onError)
          : undefined
    void asked?.then(() => this.replanSeenBy(key, heldWatchRoots))
  }

  private refreshCovered(folder: SymlinkTabFolder, heldWatchRoots: HeldWatchRoots): void {
    const covered =
      !folder.leaving &&
      (folder.candidates?.some(
        ({ key }) => this.desired.has(key) && this.status(key, heldWatchRoots) === 'watching'
      ) ??
        false)
    if (covered === folder.covered) {
      return
    }
    folder.covered = covered
    for (const { key } of folder.candidates ?? []) {
      this.uncovered.set(key, (this.uncovered.get(key) ?? 0) + (covered ? -1 : 1))
    }
  }

  private acquire(
    key: string,
    path: string,
    owner: EditorExternalWatchTarget,
    heldWatchRoots: HeldWatchRoots
  ): void {
    this.roots.set(key, path)
    // Why: a fresh request makes any earlier failure note stale; the held status speaks for it now.
    this.failed.delete(key)
    const generation = this.generation
    const root = toWatchRoot(path)
    const onError = (error: unknown): void => this.onWatchError(owner, error)
    const shared = watchRootStatus(heldWatchRoots, root) !== undefined
    const installed = acquireWatchRoot(heldWatchRoots, root, onError)
    // Why: another consumer's root may have lost its native watcher since main last answered; ask again before relying on it.
    const settled = (shared && revalidateWatchRoot(heldWatchRoots, root, onError)) || installed
    void settled.then(() => {
      if (generation === this.generation) {
        this.replanSeenBy(key, heldWatchRoots)
      }
    })
  }

  /** Releases a held watch nothing wants once every folder it sees is covered elsewhere; a failed successor keeps it. */
  private releaseIfUnneeded(key: string, heldWatchRoots: HeldWatchRoots): void {
    const path = this.roots.get(key)
    if (path === undefined || this.desired.has(key) || (this.uncovered.get(key) ?? 0) > 0) {
      return
    }
    // Why only while open: closing the folder is what forgets a failure, so a closed one would never be retried.
    if (this.isOpen(key) && watchRootStatus(heldWatchRoots, toWatchRoot(path)) === 'failed') {
      this.failed.add(key)
    }
    this.roots.delete(key)
    for (const folder of this.pins.get(key) ?? []) {
      folder.pinnedTo = undefined
    }
    this.pins.delete(key)
    releaseWatchRoot(heldWatchRoots, toWatchRoot(path))
  }
}

function toWatchRoot(path: string): WatchRootArgs {
  return { worktreePath: path, connectionId: undefined }
}
