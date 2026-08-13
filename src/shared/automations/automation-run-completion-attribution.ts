/** Provenance for a completed run. Only `exact_provider_session` is machine-verifiable. */
export type AutomationRunCompletionAttributionKind = 'exact_provider_session' | 'pane_time_fallback'

export type AutomationRunCompletionAttribution = {
  kind: AutomationRunCompletionAttributionKind
  provider: 'claude' | 'codex' | null
  providerSessionKey: 'session_id' | 'conversation_id' | null
  providerSessionId: string | null
  terminalPtyId: string | null
  terminalPaneKey: string | null
}

export function isExactAutomationRunCompletionAttribution(
  attribution: AutomationRunCompletionAttribution | null | undefined
): boolean {
  return (
    attribution?.kind === 'exact_provider_session' &&
    (attribution.providerSessionKey === 'session_id' ||
      attribution.providerSessionKey === 'conversation_id') &&
    Boolean(attribution.providerSessionId)
  )
}
