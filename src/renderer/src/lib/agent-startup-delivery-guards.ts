// Keep consumed guards store-free so tab/worktree teardown can purge them without a delayed-delivery/store import cycle.

export function agentStartupDeliveryKey(delivery: {
  worktreeId: string
  tabId: string
  launchToken: string
}): string {
  return `${delivery.worktreeId}\0${delivery.tabId}\0${delivery.launchToken}`
}

const consumedAgentStartupDeliveries = new Set<string>()

export function isAgentStartupDeliveryConsumed(key: string): boolean {
  return consumedAgentStartupDeliveries.has(key)
}

export function markAgentStartupDeliveryConsumed(key: string): void {
  consumedAgentStartupDeliveries.add(key)
}

export function releaseAgentStartupDeliveryConsumed(key: string): void {
  consumedAgentStartupDeliveries.delete(key)
}

export function clearConsumedAgentStartupDeliveriesForTests(): void {
  consumedAgentStartupDeliveries.clear()
}

// Successful guards persist until teardown; purge removed tabs/worktrees to bound session-long accumulation.
export function forgetAgentStartupDeliveriesForTabs(tabIds: Iterable<string>): void {
  const tabIdSet = tabIds instanceof Set ? tabIds : new Set(tabIds)
  if (tabIdSet.size === 0) {
    return
  }
  for (const key of consumedAgentStartupDeliveries) {
    // agentStartupDeliveryKey() is `${worktreeId}\0${tabId}\0${launchToken}`.
    const tabId = key.split('\0')[1] ?? ''
    if (tabIdSet.has(tabId)) {
      consumedAgentStartupDeliveries.delete(key)
    }
  }
}
