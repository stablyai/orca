// Index each immutable snapshot once; reset for test fixtures that mutate the map in place.
let agentSessionIdsKeyBySnapshot = new WeakMap<object, string>()
let terminalSessionIdsKeyBySnapshot = new WeakMap<object, string>()

export function getAgentSessionIdsKey(
  agentStatusByPaneKey:
    | Record<string, { providerSession?: { id?: string } | null; terminalResumeEligible?: false }>
    | undefined,
  terminalOnly = false
): string {
  if (!agentStatusByPaneKey) {
    return ''
  }
  const cache = terminalOnly ? terminalSessionIdsKeyBySnapshot : agentSessionIdsKeyBySnapshot
  const cached = cache.get(agentStatusByPaneKey)
  if (cached !== undefined) {
    return cached
  }
  const ids: string[] = []
  for (const entry of Object.values(agentStatusByPaneKey)) {
    if (terminalOnly && entry.terminalResumeEligible === false) {
      continue
    }
    if (entry.providerSession?.id) {
      ids.push(entry.providerSession.id)
    }
  }
  const key = ids.sort().join('\n')
  cache.set(agentStatusByPaneKey, key)
  return key
}

export function resetAgentSessionIdsRefreshKeys(): void {
  agentSessionIdsKeyBySnapshot = new WeakMap<object, string>()
  terminalSessionIdsKeyBySnapshot = new WeakMap<object, string>()
}
