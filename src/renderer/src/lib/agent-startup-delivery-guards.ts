// Leaf module (imports nothing from the store) holding the consumed
// agent-startup-delivery guard set, so store slices can purge it on tab/worktree
// removal without creating a store → agent-startup-delayed-delivery → store
// import cycle.

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

// Why: one consumed guard is recorded per launch that reached delivery and is
// never released on the happy path, so guards for removed tabs/worktrees would
// accumulate for the renderer's whole session. Drop them when the owning tab is
// closed or its worktree is removed.
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
