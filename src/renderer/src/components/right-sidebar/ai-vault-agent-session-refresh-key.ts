// Why: this selector runs on every store write; index each immutable status snapshot once.
// Why resettable: every production writer replaces the map, but test fixtures commonly
// mutate `mockStoreState.agentStatusByPaneKey[key]` in place, which would keep serving the
// key cached for the identity they mutated.
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
