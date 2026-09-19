export type AgentSessionDeathEvidence = {
  kind: 'exit-observed' | 'pid-absent' | 'identity-mismatch'
  detail: string
  observedAt: number
}

export function isAgentSessionDeathEvidence(value: unknown): value is AgentSessionDeathEvidence {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value.kind === 'exit-observed' ||
      value.kind === 'pid-absent' ||
      value.kind === 'identity-mismatch') &&
    'detail' in value &&
    typeof value.detail === 'string' &&
    value.detail.length > 0 &&
    value.detail.length <= 512 &&
    'observedAt' in value &&
    typeof value.observedAt === 'number' &&
    Number.isSafeInteger(value.observedAt) &&
    value.observedAt >= 0
  )
}
