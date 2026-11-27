// Kept free of copy catalogs so main-process code can import it without bundling localized strings.
type UsageFailureSource = { provider: string; usageMetadata?: { failureKind?: string } }

/** An idle login's access token lapsed, not the login: Claude refreshes it the next time it runs. */
export function isClaudeUsageWaitingForClaude(p: UsageFailureSource): boolean {
  return p.provider === 'claude' && p.usageMetadata?.failureKind === 'stale-token'
}

/** An unselected Codex login's access token lapsed; Codex renews it the next time it runs there. */
export function isCodexUsageWaitingForCodex(p: UsageFailureSource): boolean {
  return p.provider === 'codex' && p.usageMetadata?.failureKind === 'delegated-refresh-required'
}
