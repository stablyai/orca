/** Stable key for agent + provider-session identity pairs. */
export function aiVaultProviderSessionKey(agent: string, sessionId: string): string {
  // Why: unlike punctuation delimiters, NUL cannot collide with agent or
  // provider-session text, so distinct identity pairs stay distinct keys.
  return `${agent}\u0000${sessionId}`
}

/** Orca tab rename wins; scanner title already encodes harness/AI/prompt/fallback. */
export function resolveAiVaultSessionDisplayTitle(
  sessionTitle: string,
  orcaCustomTitle?: string | null
): string {
  return orcaCustomTitle?.trim() || sessionTitle
}
