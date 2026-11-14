import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'

// Answers fill the record in place, so comparing starts before applying; JSON skips the catalog's fresh closures.
export const applyKeepingIdentity = (
  current: StructuredAgentSessionOptionState,
  apply: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
) => {
  const before = JSON.stringify(current)
  const next = apply(current)
  return JSON.stringify(next) === before ? current : next
}
