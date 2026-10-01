import type { RuntimeTerminalWaitBlockedReason } from './runtime-terminal-contracts'

// Why: hosts older than the agent-neutral spellings still publish the codex-* tokens for dialogs
// their matcher never proved were Codex's, so a paired client renders the neutral equivalent
// instead of showing a Codex label to a Gemini/Cursor/Antigravity user.
// Why a Map: the reason arrives off the wire unvalidated, and a plain object would answer
// 'constructor' or 'toString' from Object.prototype and print a function to the user.
// Why one-directional: nothing consumes an agent-* -> codex-* mapping. A new host's agent-* token
// reaching an old client is rendered by that client's shipped code, which this build cannot change.
const LEGACY_CODEX_REASON_ALIASES = new Map<string, RuntimeTerminalWaitBlockedReason>([
  ['codex-update-prompt', 'agent-update-prompt'],
  ['codex-trust-workspace', 'agent-trust-workspace'],
  ['codex-cwd-prompt', 'agent-cwd-prompt'],
  ['codex-hooks-review-prompt', 'agent-hooks-review-prompt'],
  ['codex-interactive-prompt', 'agent-interactive-prompt']
])

/** Neutral spelling for a reason an older host published, or null when it is already neutral or agent-specific. */
export function agentNeutralTerminalWaitBlockedReason(
  reason: RuntimeTerminalWaitBlockedReason
): RuntimeTerminalWaitBlockedReason | null {
  return LEGACY_CODEX_REASON_ALIASES.get(reason) ?? null
}

/**
 * A blocked reason as shown to a user: the token the host published, plus the neutral spelling when
 * the host predates it. Why append and not replace: the raw token is what scripts parse.
 */
export function describeTerminalWaitBlockedReason(
  reason: RuntimeTerminalWaitBlockedReason
): string {
  const neutral = agentNeutralTerminalWaitBlockedReason(reason)
  return neutral ? `${reason} (${neutral})` : reason
}
