import { normalizeRuntimePathForComparison } from '../../../../../../shared/file-access/cross-platform-path'
import { WATCH_BATCH_INTERVAL_MS } from '../../../../../../shared/file-watch/filesystem-watch-batch-window'
import { coveringAncestors } from './editor-external-watch-symlink-coverage'
import {
  attachFolder,
  detachFolder,
  isSamePath,
  toWatchRoot,
  type FolderWatch,
  type TabFolder
} from './editor-external-watch-folder-watch'
import {
  isWatchRootFailed,
  releaseWatchRoot,
  watchRootInstalled,
  type HeldWatchRoots
} from './editor-external-watch-local-roots'

// Why: main drops a released root's unflushed batch, so the outer watch keeps reporting for many batch ticks after the handoff.
const HANDOFF_DRAIN_MS = WATCH_BATCH_INTERVAL_MS * 10

export type RetiringFolderWatch = {
  watch: FolderWatch
  targets: FolderWatch['targets']
}

export type SymlinkHandoffContext = {
  watches: Map<string, FolderWatch>
  retiring: Map<string, RetiringFolderWatch>
  heldWatchRoots: HeldWatchRoots
  isCurrentGeneration: () => boolean
  leaveWatch: (folder: TabFolder) => void
  updateNarrowing: (watch: FolderWatch) => void
}

export function cloneWatchTargets(watch: FolderWatch): FolderWatch['targets'] {
  return new Map([...watch.targets].map(([key, entry]) => [key, { ...entry }]))
}

export function findNarrowingHome(
  folder: TabFolder,
  watch: FolderWatch,
  watches: ReadonlyMap<string, FolderWatch>,
  heldWatchRoots: HeldWatchRoots
): FolderWatch | undefined {
  for (const ancestor of coveringAncestors(folder.path, watch.path) ?? [folder.path]) {
    const candidate = watches.get(normalizeRuntimePathForComparison(ancestor))
    const working = candidate && !isWatchRootFailed(heldWatchRoots, toWatchRoot(candidate.path))
    // Why the own path even when failed: starting another watch there would orphan the folders holding it.
    if (candidate && candidate !== watch && (working || isSamePath(candidate.path, folder.path))) {
      return candidate
    }
  }
  return undefined
}

/** Keeps the outer watch if any still-open child's replacement failed; otherwise drains and releases it. */
export async function completeWatchNarrowing(
  watch: FolderWatch,
  path: string,
  entry: RetiringFolderWatch,
  moved: readonly TabFolder[],
  installs: readonly Promise<void>[],
  context: SymlinkHandoffContext
): Promise<void> {
  await waitForFolderWatches(moved, installs, context)
  if (!context.isCurrentGeneration()) {
    return
  }
  const uncovered = moved.filter(
    (folder) =>
      folder.watch && isWatchRootFailed(context.heldWatchRoots, toWatchRoot(folder.watch.path))
  )
  // Why keep the outer watch: a failed or unavailable replacement leaves open children with no working watch.
  if (uncovered.length > 0 && !isWatchRootFailed(context.heldWatchRoots, toWatchRoot(watch.path))) {
    const existing = context.watches.get(path)
    const fallback = existing ?? watch
    if (!existing) {
      if (context.retiring.get(path) === entry) {
        context.retiring.delete(path)
      }
      context.watches.set(path, watch)
    }
    for (const folder of uncovered) {
      context.leaveWatch(folder)
      attachFolder(folder, fallback)
    }
    if (!existing) {
      return
    }
  }
  await new Promise((resolve) => setTimeout(resolve, HANDOFF_DRAIN_MS))
  if (!context.isCurrentGeneration()) {
    return
  }
  if (context.retiring.get(path) === entry) {
    context.retiring.delete(path)
  }
  releaseWatchRoot(context.heldWatchRoots, toWatchRoot(watch.path))
}

/** Once an outer watch installs cleanly, move covered folders from narrower watches onto it and drain those watches. */
export function scheduleAbsorbCoveredWatches(
  outer: FolderWatch,
  context: SymlinkHandoffContext
): void {
  const outerPath = normalizeRuntimePathForComparison(outer.path)
  void watchRootInstalled(context.heldWatchRoots, toWatchRoot(outer.path)).then(() => {
    if (
      !context.isCurrentGeneration() ||
      context.watches.get(outerPath) !== outer ||
      isWatchRootFailed(context.heldWatchRoots, toWatchRoot(outer.path))
    ) {
      return
    }
    absorbCoveredWatches(outer, outerPath, context)
  })
}

function absorbCoveredWatches(
  outer: FolderWatch,
  outerPath: string,
  context: SymlinkHandoffContext
): void {
  const retired: { path: string; entry: RetiringFolderWatch }[] = []
  let movedAny = false
  for (const [childPath, childWatch] of context.watches) {
    if (childWatch === outer) {
      continue
    }
    const covered: TabFolder[] = []
    for (const folder of childWatch.folders) {
      if (!folder.link) {
        continue
      }
      const ancestors = coveringAncestors(folder.path, folder.link)
      if (
        ancestors?.some((ancestor) => normalizeRuntimePathForComparison(ancestor) === outerPath)
      ) {
        covered.push(folder)
      }
    }
    if (covered.length === 0) {
      continue
    }
    movedAny = true
    const routes = cloneWatchTargets(childWatch)
    for (const folder of covered) {
      detachFolder(folder, childWatch)
      attachFolder(folder, outer)
    }
    if (childWatch.folders.size === 0) {
      clearTimeout(childWatch.narrowTimer)
      childWatch.narrowTimer = undefined
      context.watches.delete(childPath)
      const entry: RetiringFolderWatch = { watch: childWatch, targets: routes }
      context.retiring.set(childPath, entry)
      retired.push({ path: childPath, entry })
    } else {
      context.updateNarrowing(childWatch)
    }
  }
  if (movedAny) {
    context.updateNarrowing(outer)
  }
  if (retired.length === 0) {
    return
  }
  setTimeout(() => {
    if (!context.isCurrentGeneration()) {
      return
    }
    for (const { path, entry } of retired) {
      if (context.retiring.get(path) === entry) {
        context.retiring.delete(path)
      }
      releaseWatchRoot(context.heldWatchRoots, toWatchRoot(entry.watch.path))
    }
  }, HANDOFF_DRAIN_MS)
}

async function waitForFolderWatches(
  folders: readonly TabFolder[],
  initialInstalls: readonly Promise<void>[],
  context: SymlinkHandoffContext
): Promise<void> {
  const seen = new Set<Promise<void>>(initialInstalls)
  await Promise.all(initialInstalls)
  while (context.isCurrentGeneration()) {
    const pending: Promise<void>[] = []
    for (const folder of folders) {
      if (!folder.watch) {
        continue
      }
      const install = watchRootInstalled(context.heldWatchRoots, toWatchRoot(folder.watch.path))
      if (!seen.has(install)) {
        seen.add(install)
        pending.push(install)
      }
    }
    if (pending.length === 0) {
      return
    }
    await Promise.all(pending)
  }
}
