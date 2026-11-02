import type { TabWidthChanges } from '../../../../../shared/tab-strip-width'

type PendingTabWidth = { width: number | null; seq: number }

// Sent-but-unacknowledged edits; hydration replays them so a broadcast cannot revert a fresh resize.
const pendingByTabId = new Map<string, PendingTabWidth>()
let nextSeq = 0

/** Sends one tab's width as a per-tab patch instead of the whole map, so main can merge concurrent clients. */
export function persistTabWidthChange(tabId: string, width: number | null): void {
  const seq = ++nextSeq
  const settle = (): void => {
    if (pendingByTabId.get(tabId)?.seq === seq) {
      pendingByTabId.delete(tabId)
    }
  }
  const ui = typeof window === 'undefined' ? undefined : window.api?.ui
  const send = ui?.setWithAck ?? ui?.set
  if (!send) {
    return
  }
  pendingByTabId.set(tabId, { width, seq })
  const changes: TabWidthChanges = { [tabId]: width }
  try {
    void Promise.resolve(send({ tabWidthsById: changes })).then(settle, settle)
  } catch {
    settle()
  }
}

export function pendingTabWidthChanges(): TabWidthChanges {
  return Object.fromEntries([...pendingByTabId].map(([tabId, { width }]) => [tabId, width]))
}
