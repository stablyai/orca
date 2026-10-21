import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import { setWithLRU } from '@/lib/scroll-cache'
import type { DiffSection } from '../../diff-section-types'

export type CachedCombinedDiffViewState = {
  entrySignature: string
  gitStatusSignature: string
  sections: DiffSection[]
  sectionHeights: Record<number, number>
  loadedIndices: number[]
  sideBySide: boolean
}

type CombinedDiffViewMemory = {
  worktreeId: string
  succession?: CombinedDiffViewSuccessionTag
  view?: CachedCombinedDiffViewState
  scrollTop?: number
  scrollAnchor?: NonNullable<VirtualizedScrollAnchor>
}

/** The diff a tab-scoped key shows and the tab it belongs to. */
export type CombinedDiffViewSuccessionTag = {
  contentKey: string
  scopeId: string
}

/** Lets a fresh tab inherit the view its closed predecessor left for the same diff. */
export type CombinedDiffViewSuccession = CombinedDiffViewSuccessionTag & {
  isScopeOpen: (scopeId: string) => boolean
}

/** A mounted viewer's write access to its key; revoked only when its workspace is forgotten. */
export type CombinedDiffViewLease = {
  readonly viewKey: string
  readonly succession?: CombinedDiffViewSuccessionTag
  worktreeId: string
  revoked: boolean
}

const memoryByViewKey = new Map<string, CombinedDiffViewMemory>()
const mountedLeases = new Set<CombinedDiffViewLease>()

function isMountedViewKey(viewKey: string): boolean {
  for (const lease of mountedLeases) {
    if (lease.viewKey === viewKey) {
      return true
    }
  }
  return false
}

// Why: tab ids are fresh per opened tab, so a reopened tab only finds its view through the closed tab's entry.
// Open-but-inactive tabs are unmounted too, so the scope check keeps another live tab's view from being taken.
function findInheritableViewKeys(
  viewKey: string,
  worktreeId: string,
  succession: CombinedDiffViewSuccession
): string[] {
  const keys: string[] = []
  for (const [candidateKey, memory] of memoryByViewKey) {
    if (
      candidateKey !== viewKey &&
      memory.worktreeId === worktreeId &&
      memory.succession?.contentKey === succession.contentKey &&
      !succession.isScopeOpen(memory.succession.scopeId) &&
      !isMountedViewKey(candidateKey)
    ) {
      keys.push(candidateKey)
    }
  }
  // Map order is LRU order, so the last key is the most recently written view.
  return keys
}

/** Without `inherit` this reads only `viewKey`; with it, a key that has no view yet previews what it would inherit. */
export function readCombinedDiffViewMemory(
  viewKey: string,
  inherit?: { worktreeId: string; succession: CombinedDiffViewSuccession }
): Readonly<CombinedDiffViewMemory> | undefined {
  const own = memoryByViewKey.get(viewKey)
  if (own || !inherit) {
    return own
  }
  const inheritedKey = findInheritableViewKeys(viewKey, inherit.worktreeId, inherit.succession).at(
    -1
  )
  return inheritedKey === undefined ? undefined : memoryByViewKey.get(inheritedKey)
}

export function claimCombinedDiffView(
  viewKey: string,
  worktreeId: string,
  succession?: CombinedDiffViewSuccession
): CombinedDiffViewLease {
  if (memoryByViewKey.get(viewKey)?.worktreeId !== worktreeId) {
    memoryByViewKey.delete(viewKey)
  }
  const tag = succession ? { contentKey: succession.contentKey, scopeId: succession.scopeId } : null
  if (succession && tag && !memoryByViewKey.has(viewKey)) {
    const inheritableKeys = findInheritableViewKeys(viewKey, worktreeId, succession)
    const inherited = memoryByViewKey.get(inheritableKeys.at(-1) ?? '')
    // Why: move rather than copy, and drop older closed tabs' views of this diff — they hold file bodies nothing can reach.
    for (const key of inheritableKeys) {
      memoryByViewKey.delete(key)
    }
    if (inherited) {
      setWithLRU(memoryByViewKey, viewKey, { ...inherited, succession: tag })
    }
  }
  const lease: CombinedDiffViewLease = {
    viewKey,
    ...(tag ? { succession: tag } : {}),
    worktreeId,
    revoked: false
  }
  mountedLeases.add(lease)
  return lease
}

// Why: release only stops tracking — the viewer's unmount snapshot still writes through the lease afterwards.
export function releaseCombinedDiffView(lease: CombinedDiffViewLease): void {
  mountedLeases.delete(lease)
}

export function rememberCombinedDiffView(
  lease: CombinedDiffViewLease | null,
  patch: Partial<Omit<CombinedDiffViewMemory, 'worktreeId'>>
): void {
  if (!lease || lease.revoked) {
    return
  }
  const memory = memoryByViewKey.get(lease.viewKey)
  const owned = memory?.worktreeId === lease.worktreeId ? memory : { worktreeId: lease.worktreeId }
  setWithLRU(memoryByViewKey, lease.viewKey, {
    ...owned,
    ...patch,
    ...(lease.succession ? { succession: lease.succession } : {})
  })
}

// Why: a cached view may hold unsaved section edits; invalidation resets only clean, loaded sections so
// they reload on remount, and a dirty section's guarded save or conflict bar handles a disk change.
function invalidateCleanSections(
  view: CachedCombinedDiffViewState,
  isStale: (section: DiffSection) => boolean
): CachedCombinedDiffViewState {
  let changed = false
  const sections = view.sections.map((section) => {
    if (
      section.dirty ||
      section.saveConflict ||
      section.loading ||
      section.loadOnDemand === true ||
      !isStale(section)
    ) {
      return section
    }
    changed = true
    return {
      ...section,
      originalContent: '',
      modifiedContent: '',
      loading: true,
      error: undefined,
      diffResult: null,
      largeDiffRenderLimit: null,
      contentGeneration: (section.contentGeneration ?? 0) + 1
    }
  })
  if (!changed) {
    return view
  }
  return {
    ...view,
    sections,
    loadedIndices: view.loadedIndices.filter((index) => sections[index] === view.sections[index])
  }
}

function invalidateCachedViews(
  matches: (memory: CombinedDiffViewMemory) => boolean,
  isStale: (section: DiffSection) => boolean
): void {
  for (const [viewKey, memory] of memoryByViewKey) {
    if (!memory.view || !matches(memory)) {
      continue
    }
    const view = invalidateCleanSections(memory.view, isStale)
    if (view !== memory.view) {
      memoryByViewKey.set(viewKey, { ...memory, view })
    }
  }
}

export function forgetCombinedDiffViewsShowingPath(relativePath: string): void {
  invalidateCachedViews(
    () => true,
    (section) => section.path === relativePath
  )
}

/** An overflow names no paths, so every clean cached section of the workspace may be stale. */
export function forgetCombinedDiffViewBodiesForWorktree(worktreeId: string): void {
  invalidateCachedViews(
    (memory) => memory.worktreeId === worktreeId,
    () => true
  )
}

export function renameCombinedDiffViewOwner(oldWorktreeId: string, newWorktreeId: string): void {
  for (const [viewKey, memory] of memoryByViewKey) {
    if (memory.worktreeId === oldWorktreeId) {
      memoryByViewKey.set(viewKey, { ...memory, worktreeId: newWorktreeId })
    }
  }
  for (const lease of mountedLeases) {
    if (lease.worktreeId === oldWorktreeId) {
      lease.worktreeId = newWorktreeId
    }
  }
}

/** A deleted workspace cannot restore its cached file bodies. Ordinary tab closes keep them. */
export function forgetCombinedDiffViewsForWorktrees(worktreeIds: Iterable<string>): void {
  const removed = new Set(worktreeIds)
  for (const [viewKey, memory] of memoryByViewKey) {
    if (removed.has(memory.worktreeId)) {
      memoryByViewKey.delete(viewKey)
    }
  }
  for (const lease of mountedLeases) {
    if (removed.has(lease.worktreeId)) {
      lease.revoked = true
      mountedLeases.delete(lease)
    }
  }
}

export function clearCombinedDiffViewMemory(): void {
  memoryByViewKey.clear()
  mountedLeases.clear()
}
