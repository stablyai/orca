// Pure inputs for the base-harness disable confirmation (plan §973). Enabled
// derivative counts come from the local catalog snapshot; saved-reference and
// resumable-session counts come from the host `baseDisableImpact` query. Node-free
// so it unit-tests without a DOM.

import type { BaseDisableImpact } from '../../../../shared/agent-reference-snapshot'
import type { LocalAgentCatalogSnapshot } from '../../../../shared/agent-catalog-snapshot'
import type { BuiltInTuiAgent } from '../../../../shared/types'

/** Enabled custom derivatives of a base: ready customs on that base that are not
 *  themselves disabled. Disabling the base makes every one of them unlaunchable
 *  without copying their ids into `disabledAgents` (R23), so they are affected
 *  even though they are individually enabled. */
export function countEnabledDerivatives(
  snapshot: LocalAgentCatalogSnapshot,
  base: BuiltInTuiAgent
): number {
  const disabled = new Set(snapshot.disabledAgents)
  return snapshot.customAgents.filter(
    (agent) =>
      agent.status === 'ready' &&
      agent.definition.baseAgent === base &&
      !disabled.has(agent.definition.id)
  ).length
}

/** Disabling a base is immediate only when nothing it affects exists: no enabled
 *  derivatives, no saved references, no resumable sessions, and no unreadable
 *  owner store (which could hide references). Otherwise the confirmation opens so
 *  the blocking consequences are shown first. */
export function baseDisableNeedsConfirmation(args: {
  enabledDerivatives: number
  impact: BaseDisableImpact
}): boolean {
  const { enabledDerivatives, impact } = args
  return (
    enabledDerivatives > 0 ||
    impact.savedReferences.count > 0 ||
    impact.savedReferences.atLeast ||
    impact.resumableSessions.count > 0 ||
    impact.resumableSessions.atLeast
  )
}
