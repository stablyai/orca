// Window-local editor content (open file records, drafts, buffers, the autosave gate) that a
// switch-on move or rename of editor tabs rekeys. The window asks main first; the frame flush that
// first shows main's change applies the rekey in the same store update, so no render shows the
// tabs under their new ids beside content under the old ones. A refusal drops it unapplied.

import type { AppState } from '@/store/types'
import type { WorkspaceLayoutCache } from '@/store/workspace-layout-cache'

export type ContentRekey = {
  /** Whether these frames show main's change. Never true for a change no tab shows. */
  shows: (cache: WorkspaceLayoutCache) => boolean
  /** The rekey against the store as the frame finds it. */
  patch: (state: AppState) => Partial<AppState>
}

type Entry = { rekey: ContentRekey; fileIds: readonly string[]; waiters: ((ok: boolean) => void)[] }

/** A rekey outlives its frame only when main never answers. Past the cap the oldest settles as
 *  dropped (its waiters hear false) and its content stays under the old ids. */
const MAX_REKEYS = 64

const pending = new Set<Entry>()

function finish(entry: Entry, ok: boolean): void {
  if (!pending.delete(entry)) {
    return
  }
  for (const run of entry.waiters) {
    run(ok)
  }
}

export type ExpectedContentRekey = {
  /** Main applied the change: the rekey runs now unless its frame already ran it. */
  applied: (show: (patch: Partial<AppState>) => void, state: AppState) => void
  /** Main refused, or the window did it itself: nothing is applied. */
  dropped: () => void
}

/** Registers a rekey of these files (by old and new ids) until its frame or main's answer settles it. */
export function expectContentRekey(
  rekey: ContentRekey,
  fileIds: readonly string[]
): ExpectedContentRekey {
  const entry: Entry = { rekey, fileIds, waiters: [] }
  pending.add(entry)
  if (pending.size > MAX_REKEYS) {
    const oldest = pending.values().next().value
    if (oldest) {
      finish(oldest, false)
    }
  }
  return {
    applied: (show, state) => {
      if (!pending.has(entry)) {
        return
      }
      // A throwing rekey settles as dropped, so its waiters never hang.
      let ok = false
      try {
        show(rekey.patch(state))
        ok = true
      } finally {
        finish(entry, ok)
      }
    },
    dropped: () => finish(entry, false)
  }
}

/** A tab's ids before and after a move or rename. */
export type TabRekey = { tabId: string; entityId: string; newTabId: string; newEntityId: string }

/** Whether these frames show every tab under its new ids in `to`, and none under its old in `from`. */
export function framesShowTabRekeys(
  cache: WorkspaceLayoutCache,
  from: string,
  to: string,
  tabs: readonly TabRekey[]
): boolean {
  return (
    tabs.length > 0 &&
    tabs.every(
      (tab) =>
        !cache[from]?.tabs.some(
          (entry) => entry.id === tab.tabId && entry.entityId === tab.entityId
        ) &&
        cache[to]?.tabs.some(
          (entry) => entry.id === tab.newTabId && entry.entityId === tab.newEntityId
        ) === true
    )
  )
}

/** The rekeys these frames show, applied over `state` as one patch; each is taken once. */
export function shownContentRekeyPatch(
  state: AppState,
  cache: WorkspaceLayoutCache
): Partial<AppState> {
  let patch: Partial<AppState> = {}
  for (const entry of pending) {
    if (entry.rekey.shows(cache)) {
      let ok = false
      try {
        patch = { ...patch, ...entry.rekey.patch({ ...state, ...patch }) }
        ok = true
      } finally {
        finish(entry, ok)
      }
    }
  }
  return patch
}

/** Resolves true once the pending rekeys of these files (old or new ids) are applied, false when one was dropped. */
export function contentRekeyOutcome(fileIds: readonly string[]): Promise<boolean> {
  const waiting = [...pending].filter((entry) =>
    entry.fileIds.some((fileId) => fileIds.includes(fileId))
  )
  return Promise.all(
    waiting.map((entry) => new Promise<boolean>((resolve) => entry.waiters.push(resolve)))
  ).then((outcomes) => outcomes.every(Boolean))
}

export function _resetContentRekeysForTests(): void {
  pending.clear()
}
