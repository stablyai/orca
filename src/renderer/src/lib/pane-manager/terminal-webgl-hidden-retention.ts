import type { ManagedPaneInternal } from './pane-manager-types'
import { disposeWebgl } from './pane-webgl-renderer'

// Even with Blink’s context ceiling raised to 128, cap hidden retention at six to bound GPU memory as mounted worktrees accumulate.
const MAX_RETAINED_HIDDEN_WEBGL_CONTEXTS = 6

/** Identity of the surface whose hidden panes are retained; compared by reference only. */
export type HiddenWebglRetentionOwner = WeakKey

type RetainedHiddenEntry = {
  owner: HiddenWebglRetentionOwner
  livePanes: () => Iterable<ManagedPaneInternal>
}

// LRU: oldest suspend first.
const retainedEntries: RetainedHiddenEntry[] = []

function liveContextCount(entry: RetainedHiddenEntry): number {
  let count = 0
  for (const pane of entry.livePanes()) {
    if (pane.webglAddon) {
      count += 1
    }
  }
  return count
}

function disposeEntryContexts(entry: RetainedHiddenEntry): void {
  for (const pane of entry.livePanes()) {
    disposeWebgl(pane)
  }
}

function removeEntry(owner: HiddenWebglRetentionOwner): void {
  const index = retainedEntries.findIndex((entry) => entry.owner === owner)
  if (index !== -1) {
    retainedEntries.splice(index, 1)
  }
}

/** Retain live addons on hide, evicting least-recently-hidden owners under the cap. True tells callers to skip disposal. */
export function tryRetainHiddenPanesWebgl(
  owner: HiddenWebglRetentionOwner,
  livePanes: () => Iterable<ManagedPaneInternal>
): boolean {
  removeEntry(owner)
  const entry: RetainedHiddenEntry = { owner, livePanes }
  const ownCount = liveContextCount(entry)
  // Dispose empty/oversized owners normally so one tab cannot thrash all retained siblings.
  if (ownCount === 0 || ownCount > MAX_RETAINED_HIDDEN_WEBGL_CONTEXTS) {
    return false
  }
  let total = ownCount
  for (const other of retainedEntries) {
    total += liveContextCount(other)
  }
  while (total > MAX_RETAINED_HIDDEN_WEBGL_CONTEXTS && retainedEntries.length > 0) {
    const evicted = retainedEntries.shift()!
    total -= liveContextCount(evicted)
    disposeEntryContexts(evicted)
  }
  retainedEntries.push(entry)
  return true
}

/** Drop retention bookkeeping on reveal/destroy; never disposes live addons. */
export function releaseHiddenWebglRetention(owner: HiddenWebglRetentionOwner): void {
  removeEntry(owner)
}

export function retainedHiddenWebglOwnerCountForTest(): number {
  return retainedEntries.length
}

export function resetHiddenWebglRetentionForTest(): void {
  retainedEntries.length = 0
}
