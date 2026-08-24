import type { ProviderRateLimits } from './rate-limit-types'
import type { TuiAgent } from './tui-agent'

/** Install-independent usage and plan coverage for a launchable TUI agent. */
export type TuiAgentUsageSupport = {
  /** Orca adapter that can supply quota data for this agent, when one exists. */
  usageProvider: ProviderRateLimits['provider'] | null
  /** Credential path used by Orca's usage adapter, not the agent's launch auth. */
  usageAuth: 'oauth' | 'oauth-or-cli' | 'shared-gemini-oauth' | 'none'
  /** Whether the adapter currently has a provider-owned plan label to report. */
  planLabelSource: 'provider-account' | 'not-exposed'
}

const noUsageAdapter: TuiAgentUsageSupport = {
  usageProvider: null,
  usageAuth: 'none',
  planLabelSource: 'not-exposed'
}

/** Static coverage for every Orca TuiAgent; runtime detection is separate. */
export const TUI_AGENT_USAGE_SUPPORT = {
  claude: {
    usageProvider: 'claude',
    usageAuth: 'oauth-or-cli',
    planLabelSource: 'provider-account'
  },
  'claude-agent-teams': {
    usageProvider: 'claude',
    usageAuth: 'oauth-or-cli',
    planLabelSource: 'provider-account'
  },
  openclaude: noUsageAdapter,
  codex: { usageProvider: 'codex', usageAuth: 'oauth', planLabelSource: 'provider-account' },
  autohand: noUsageAdapter,
  // OpenCode can use many upstream accounts; OpenCode Go is a separate
  // cookie-backed adapter and must not be inferred for the generic CLI.
  opencode: noUsageAdapter,
  'mimo-code': noUsageAdapter,
  pi: noUsageAdapter,
  omp: noUsageAdapter,
  gemini: { usageProvider: 'gemini', usageAuth: 'oauth', planLabelSource: 'not-exposed' },
  antigravity: {
    usageProvider: 'antigravity',
    usageAuth: 'shared-gemini-oauth',
    planLabelSource: 'not-exposed'
  },
  aider: noUsageAdapter,
  goose: noUsageAdapter,
  amp: noUsageAdapter,
  kilo: noUsageAdapter,
  kiro: noUsageAdapter,
  crush: noUsageAdapter,
  aug: noUsageAdapter,
  cline: noUsageAdapter,
  codebuff: noUsageAdapter,
  'command-code': noUsageAdapter,
  continue: noUsageAdapter,
  cursor: noUsageAdapter,
  droid: noUsageAdapter,
  kimi: { usageProvider: 'kimi', usageAuth: 'oauth', planLabelSource: 'not-exposed' },
  'mistral-vibe': noUsageAdapter,
  'qwen-code': noUsageAdapter,
  rovo: noUsageAdapter,
  hermes: noUsageAdapter,
  openclaw: noUsageAdapter,
  copilot: noUsageAdapter,
  grok: { usageProvider: 'grok', usageAuth: 'oauth', planLabelSource: 'provider-account' },
  devin: noUsageAdapter,
  ante: noUsageAdapter,
  trae: noUsageAdapter,
  'prime-agent': noUsageAdapter
} satisfies Record<TuiAgent, TuiAgentUsageSupport>

export function getTuiAgentUsageSupport(agent: TuiAgent): TuiAgentUsageSupport {
  return TUI_AGENT_USAGE_SUPPORT[agent]
}
