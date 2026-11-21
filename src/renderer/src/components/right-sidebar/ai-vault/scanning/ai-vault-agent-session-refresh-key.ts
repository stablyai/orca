import type { AcceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'

let cached: { statuses: AcceptedAgentStatuses; revision: number; key: string } | undefined

export function getAgentSessionIdsKey(statuses: AcceptedAgentStatuses): string {
  if (cached?.revision === statuses.sessionRevision && cached.statuses.sharesOwner(statuses)) {
    return cached.key
  }
  const ids: string[] = []
  for (const entry of statuses.values()) {
    if (entry.providerSession?.id) {
      ids.push(entry.providerSession.id)
    }
  }
  const key = ids.sort().join('\n')
  cached = { statuses, revision: statuses.sessionRevision, key }
  return key
}

export function resetAgentSessionIdsRefreshKeys(): void {
  cached = undefined
}
