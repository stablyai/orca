import type { TabWidthChanges } from '../../../../../shared/tab-strip-width'

type PendingTabWidth = { width: number | null; seq: number }

// Unacknowledged edits; hydration replays them so a broadcast or failed write cannot revert a resize.
const pendingByTabId = new Map<string, PendingTabWidth>()
let nextSeq = 0

/** Sends one tab's width as a per-tab patch instead of the whole map, so main can merge concurrent clients. */
export function persistTabWidthChange(tabId: string, width: number | null): void {
  const ui = typeof window === 'undefined' ? undefined : window.api?.ui
  const send = ui?.setWithAck ?? ui?.set
  if (!send) {
    return
  }
  pendingByTabId.set(tabId, { width, seq: ++nextSeq })
  // Why: like the persisted-UI writer, a rejected patch stays pending and rides along with the next edit; no auto-retry.
  const sent = new Map(pendingByTabId)
  const acknowledge = (): void => {
    for (const [sentTabId, { seq }] of sent) {
      if (pendingByTabId.get(sentTabId)?.seq === seq) {
        pendingByTabId.delete(sentTabId)
      }
    }
  }
  try {
    void Promise.resolve(send({ tabWidthsById: pendingTabWidthChanges() })).then(
      acknowledge,
      () => {}
    )
  } catch {
    // Kept pending for the next edit.
  }
}

export function pendingTabWidthChanges(): TabWidthChanges {
  return Object.fromEntries([...pendingByTabId].map(([tabId, { width }]) => [tabId, width]))
}
