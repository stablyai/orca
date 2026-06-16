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
