import type { Tab } from './tab-types'

/** The worker peek follows the file preview, or occupies the final strip slot. */
export function workerTabStripOrder(
  order: string[],
  tabs: readonly Pick<Tab, 'id' | 'isPreview'>[],
  peekTabId: string | undefined
): string[] {
  if (!peekTabId || !order.includes(peekTabId)) {
    return order
  }
  const next = order.filter((id) => id !== peekTabId)
  const previewId = tabs.find((tab) => tab.isPreview)?.id
  const previewIndex = previewId ? next.indexOf(previewId) : -1
  next.splice(previewIndex < 0 ? next.length : previewIndex + 1, 0, peekTabId)
  return next
}
