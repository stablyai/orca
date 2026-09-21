import {
  serializeAgentStatusProviderAliasKey,
  type AgentStatusRunAliasIndex
} from './agent-status-run-alias-index'
import type { AgentStatusParentRecord } from './agent-status-store-parent'

export function deriveAgentStatusStoreRunAliasIndex(
  parents: Iterable<AgentStatusParentRecord>
): AgentStatusRunAliasIndex {
  const index: AgentStatusRunAliasIndex = new Map()
  for (const parent of parents) {
    if (parent.subject.kind !== 'pty-run' || !parent.run) {
      continue
    }
    for (const session of parent.run.providerSessions) {
      const key = serializeAgentStatusProviderAliasKey({
        executionHostId: parent.subject.executionHostId,
        wslDistro: parent.subject.wslDistro,
        workspaceId: parent.subject.workspaceId,
        workspaceKind: parent.subject.workspaceKind,
        provider: session.provider,
        sessionKeyKind: session.sessionKeyKind,
        providerId: session.providerId
      })
      const runIds = index.get(key) ?? new Set<string>()
      runIds.add(parent.run.runId)
      index.set(key, runIds)
    }
  }
  return index
}
