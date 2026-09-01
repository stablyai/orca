// Pure input for the reference-aware custom-agent disable confirmation (plan
// §973): the total saved references that a disable will affect. Node-free so it
// unit-tests without a DOM.

import type { AgentReferenceSummary } from '../../../../shared/agent-reference-snapshot'

export type DisableReferenceTotal = {
  /** Sum of readable reference counts across every owner. Unlike the delete
   *  summary, `default` is NOT excluded: a disabled custom that is the current
   *  default falls back to the stock base, so that reference is affected too. */
  total: number
  /** At least one owner store returned -1 (could not be read), so `total` is a
   *  floor and the agent cannot be proven unreferenced. */
  unreadable: boolean
}

export function summarizeDisableReferences(
  summary: readonly AgentReferenceSummary[]
): DisableReferenceTotal {
  let total = 0
  let unreadable = false
  for (const row of summary) {
    if (row.count < 0) {
      unreadable = true
      continue
    }
    total += row.count
  }
  return { total, unreadable }
}

/** Disabling a custom is immediate only when it is provably unreferenced: zero
 *  readable references and no unreadable owner store. Otherwise the confirmation
 *  opens so the fallback/failure/replay consequences are shown first. */
export function disableNeedsConfirmation(summary: readonly AgentReferenceSummary[]): boolean {
  const { total, unreadable } = summarizeDisableReferences(summary)
  return total > 0 || unreadable
}
