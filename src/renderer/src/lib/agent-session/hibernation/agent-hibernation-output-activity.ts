const outputEpochByPaneKey = new Map<string, number>()

export function recordAgentHibernationPaneOutput(paneKey: string): void {
  if (!paneKey) {
    return
  }
  outputEpochByPaneKey.set(paneKey, getAgentHibernationPaneOutputEpoch(paneKey) + 1)
}

export function getAgentHibernationPaneOutputEpoch(paneKey: string): number {
  return outputEpochByPaneKey.get(paneKey) ?? 0
}

// Purge permanently removed panes to bound this renderer-lifetime map; reopened panes use fresh UUIDs and start at epoch 0.
export function forgetAgentHibernationPaneOutput(paneKey: string): void {
  outputEpochByPaneKey.delete(paneKey)
}

// Mirror tab/worktree bulk teardown so callers need no separate prefix scan.
export function forgetAgentHibernationTabOutput(tabId: string): void {
  const prefix = `${tabId}:`
  for (const paneKey of outputEpochByPaneKey.keys()) {
    if (paneKey.startsWith(prefix)) {
      outputEpochByPaneKey.delete(paneKey)
    }
  }
}

export function getAgentHibernationOutputSignature(paneKeys: readonly string[]): string {
  return paneKeys
    .slice()
    .sort()
    .map((paneKey) => `${paneKey}:${getAgentHibernationPaneOutputEpoch(paneKey)}`)
    .join('|')
}

export function resetAgentHibernationOutputActivityForTests(): void {
  outputEpochByPaneKey.clear()
}
