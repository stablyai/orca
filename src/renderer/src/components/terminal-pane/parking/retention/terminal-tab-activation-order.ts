/** Ranks tabs hidden in the same pass by the user's activation order. */
export type TerminalTabActivationOrder = {
  recordActiveTabId(activeTabId: string | null): void
  getActivationSeq(tabId: string): number | undefined
  retainTabIds(liveTabIds: ReadonlySet<string>): void
}

export function createTerminalTabActivationOrder(): TerminalTabActivationOrder {
  const activationSeqByTabId = new Map<string, number>()
  let previousActiveTabId: string | null = null
  let nextActivationSeq = 0

  return {
    recordActiveTabId(activeTabId) {
      if (activeTabId !== null && activeTabId !== previousActiveTabId) {
        activationSeqByTabId.set(activeTabId, nextActivationSeq)
        nextActivationSeq += 1
      }
      previousActiveTabId = activeTabId
    },
    getActivationSeq(tabId) {
      return activationSeqByTabId.get(tabId)
    },
    retainTabIds(liveTabIds) {
      if (previousActiveTabId !== null && !liveTabIds.has(previousActiveTabId)) {
        previousActiveTabId = null
      }
      for (const tabId of Array.from(activationSeqByTabId.keys())) {
        if (!liveTabIds.has(tabId)) {
          activationSeqByTabId.delete(tabId)
        }
      }
    }
  }
}
