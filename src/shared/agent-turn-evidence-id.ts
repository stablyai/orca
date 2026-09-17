const MAX_AGENT_TURN_EVIDENCE_ID_LENGTH = 512

/** Retain stable evidence entropy without exceeding the lifecycle contract's identifier bound. */
export function boundedAgentTurnEvidenceId(value: string): string {
  if (value.length <= MAX_AGENT_TURN_EVIDENCE_ID_LENGTH) {
    return value
  }
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ (code + index), 0x01000193)
  }
  return `agent-turn-evidence:digest:${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`
}
