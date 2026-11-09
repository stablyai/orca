// Index each immutable snapshot once; reset for test fixtures that mutate the map in place.
let agentSessionIdsKeyBySnapshot = new WeakMap<object, string>()

export function getAgentSessionIdsKey(
  agentStatusByPaneKey: Record<string, { providerSession?: { id?: string } | null }> | undefined
): string {
  if (!agentStatusByPaneKey) {
    return ''
  }
  const cached = agentSessionIdsKeyBySnapshot.get(agentStatusByPaneKey)
  if (cached !== undefined) {
    return cached
  }
  const ids: string[] = []
  for (const entry of Object.values(agentStatusByPaneKey)) {
    if (entry.providerSession?.id) {
      ids.push(entry.providerSession.id)
    }
  }
  const key = ids.sort().join('\n')
  agentSessionIdsKeyBySnapshot.set(agentStatusByPaneKey, key)
  return key
}

export function resetAgentSessionIdsRefreshKeys(): void {
  agentSessionIdsKeyBySnapshot = new WeakMap<object, string>()
}
