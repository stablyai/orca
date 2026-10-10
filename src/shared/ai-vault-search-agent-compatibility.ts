import type { AiVaultAgent } from './ai-vault-types'
import type { AiVaultSearchStatus } from './ai-vault-search-types'

// Frozen to the v1.4.211 parser; extending the current catalog must not widen old-host requests.
const LEGACY_SEARCH_AGENTS: readonly AiVaultAgent[] = [
  'claude',
  'codex',
  'hermes',
  'pi',
  'omp',
  'prime-agent',
  'cursor',
  'gemini',
  'antigravity',
  'rovo',
  'copilot',
  'opencode',
  'opencode2',
  'grok',
  'openclaw',
  'devin',
  'droid',
  'cline',
  'kimi',
  'muse'
]

export function compatibleSearchAgents(
  agents: readonly AiVaultAgent[],
  status: Pick<
    AiVaultSearchStatus,
    'supportedAgents' | 'supportsQoderHistory' | 'supportsJcodeHistory'
  >
): AiVaultAgent[] {
  // Qoder's shipped capability also proves the earlier CodeBuddy and ZCode enum additions.
  const supported = new Set(
    status.supportedAgents ?? [
      ...LEGACY_SEARCH_AGENTS,
      ...(status.supportsQoderHistory === true ? ['codebuddy', 'zcode', 'qoder'] : []),
      ...(status.supportsJcodeHistory === true ? ['jcode'] : [])
    ]
  )
  return agents.filter((agent) => supported.has(agent))
}
