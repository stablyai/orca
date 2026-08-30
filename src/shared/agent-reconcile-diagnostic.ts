export type AgentReconcileDiagnostic = {
  kind: 'unverifiable'
  reason: 'remote-contact-lost' | 'transcript-unreadable' | 'owner-unavailable'
  observedAt: number
}

export function normalizeAgentReconcileDiagnostic(
  value: unknown
): AgentReconcileDiagnostic | null | undefined {
  if (value === null) {
    return null
  }
  if (typeof value !== 'object') {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  const reason = candidate.reason
  if (
    candidate.kind !== 'unverifiable' ||
    (reason !== 'remote-contact-lost' &&
      reason !== 'transcript-unreadable' &&
      reason !== 'owner-unavailable') ||
    typeof candidate.observedAt !== 'number' ||
    !Number.isFinite(candidate.observedAt)
  ) {
    return undefined
  }
  return { kind: 'unverifiable', reason, observedAt: candidate.observedAt }
}
