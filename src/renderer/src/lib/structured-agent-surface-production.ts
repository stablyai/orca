import type { StructuredAgentLaunchSettlement } from './structured-agent-launch-settlement'
import type { WorkspaceSurfaceProducer } from './workspace-surface-production'

export function settleStructuredAgentSurfaceProducer(
  producer: WorkspaceSurfaceProducer,
  workspaceKey: string,
  settlement: StructuredAgentLaunchSettlement | null
): void {
  if (producer.attempt.workspaceKey !== workspaceKey) {
    producer.failed('The agent launch settled for a different workspace.')
    return
  }
  if (!settlement) {
    producer.failed('The agent launch did not start.')
    return
  }
  if (settlement.kind === 'visibility-unknown') {
    producer.unverifiable('The execution host may have accepted the agent launch.')
    return
  }
  const fallbackTabId =
    settlement.kind === 'refused-then-legacy'
      ? settlement.primaryTabId
      : settlement.kind === 'cancelled'
        ? settlement.fallback?.primaryTabId
        : null
  if (fallbackTabId) {
    producer.materialized({ kind: 'tab', id: fallbackTabId })
    return
  }
  if (settlement.kind === 'failed') {
    producer.failed(settlement.error)
    return
  }
  if (settlement.kind === 'cancelled') {
    producer.unverifiable('The cancelled agent launch could not be reconciled with its host.')
    return
  }
  if (settlement.kind === 'refused-then-legacy') {
    producer.failed('The agent launch did not publish a surface.')
    return
  }
  producer.materialized({ kind: 'tab', id: `agent-session:${settlement.sessionId}` })
}
