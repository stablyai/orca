// Pure inputs for the custom-agent delete confirmation: the recommended default
// rebind when the deleted agent is the current default, and the reference-summary
// total shown as "Used by N saved items". Node-free so it unit-tests without a DOM.

import type { BuiltInTuiAgent, GlobalSettings, TuiAgent } from '../../../../shared/types'
import type { AgentReferenceSummary } from '../../../../shared/agent-reference-snapshot'

/** The four `delete-custom` onDefault outcomes offered when the agent is the
 *  current default (plan §995). `base`/`auto` are the recommendable ones. */
export type DeleteDefaultChoice = 'base' | 'auto' | 'keep' | 'clear'

export type DeleteDefaultRecommendation = {
  /** Pre-selected outcome: `base` only when the base is currently launchable and
   *  enabled, otherwise `auto` for broader recovery. */
  recommended: Extract<DeleteDefaultChoice, 'base' | 'auto'>
  /** The base's effective prefix is currently launchable (configured executable or
   *  stock-detected) and the base is enabled, so rebinding straight to it is safe. */
  baseLaunchable: boolean
  /** False while PATH detection is still in flight — availability is unknown, so the
   *  recommendation notes it will be checked at launch, not guaranteed. */
  detectionKnown: boolean
}

export function recommendDeleteDefault(input: {
  base: BuiltInTuiAgent
  detectedIds: ReadonlySet<string> | null
  agentCmdOverrides: GlobalSettings['agentCmdOverrides']
  disabledAgents: ReadonlySet<TuiAgent>
}): DeleteDefaultRecommendation {
  const { base, detectedIds, agentCmdOverrides, disabledAgents } = input
  const detectionKnown = detectedIds !== null
  // A configured base executable (`base` uses the built-in's own global command)
  // is launchable without stock PATH detection; a concrete missing stock base is
  // not. Unknown detection stays not-launchable so we fall to Auto.
  const configured = Boolean(agentCmdOverrides?.[base])
  const stockDetected = detectedIds !== null && detectedIds.has(base)
  const baseEnabled = !disabledAgents.has(base)
  const baseLaunchable = baseEnabled && (configured || stockDetected)
  return {
    recommended: baseLaunchable ? 'base' : 'auto',
    baseLaunchable,
    detectionKnown
  }
}

export type DeleteReferenceTotal = {
  /** Sum of readable non-default reference counts. The `default` owner is excluded
   *  because the confirmation's own rebind selector already governs it. */
  total: number
  /** At least one owner store returned -1 (could not be read), so `total` is a
   *  floor rather than an exact count. */
  unreadable: boolean
}

export function summarizeDeleteReferences(
  summary: readonly AgentReferenceSummary[]
): DeleteReferenceTotal {
  let total = 0
  let unreadable = false
  for (const row of summary) {
    if (row.owner === 'default') {
      continue
    }
    if (row.count < 0) {
      unreadable = true
      continue
    }
    total += row.count
  }
  return { total, unreadable }
}
