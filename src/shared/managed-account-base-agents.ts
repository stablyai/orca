import type { BuiltInTuiAgent } from './types'

// Why: only Codex and Claude have Orca-managed account state (the codex-accounts
// and claude-accounts services). A launch for one of these bases can inject the
// selected managed account's auth/home env (CODEX_HOME, CLAUDE_CONFIG_DIR), which
// an explicit custom-agent env row then overrides — the precedence the editor
// must surface. Every other base has no managed account for a row to override, so
// the managed-account precedence copy would be misleading there.
export const MANAGED_ACCOUNT_BASE_AGENTS = new Set<BuiltInTuiAgent>(['codex', 'claude'])

export function baseAgentUsesManagedAccount(base: BuiltInTuiAgent): boolean {
  return MANAGED_ACCOUNT_BASE_AGENTS.has(base)
}
