import type { AgentStatusOrchestrationContext } from './agent-status-types'
import type { OrcaSessionId } from './orca-session-address'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { RuntimeWorktreePsSummary } from './runtime-types'

// Keep desktop-only imports in the native fixture; its export checks this consumer contract.
export type RuntimeAgentLineageTestModule = {
  LINEAGE_PARENT: OrcaSessionId
  LINEAGE_CHILD: OrcaSessionId
  canonicalChatRow(id: string): string
  publicLineageFixture(worktreeId?: string): {
    db: {
      db: { prepare(sql: string): { run(...values: string[]): unknown } }
      close(): void
    }
    projection: {
      buildByPaneKey(): Record<string, AgentStatusOrchestrationContext> | undefined
    }
    build(): RuntimeWorktreePsSummary
    privateHandle: string
    privatePane: string
    run: { id: string }
  }
}

export type RuntimeAgentLineageCatalogTestModule = {
  createLineageCatalogDispatcher(build: () => RuntimeWorktreePsSummary): {
    dispatch(request: {
      id: string
      authToken: string
      method: string
      params?: Record<string, unknown>
    }): Promise<RuntimeRpcResponse<unknown>>
  }
}
