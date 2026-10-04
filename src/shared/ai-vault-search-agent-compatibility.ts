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

export function needsSearchAgentNegotiation(agents: readonly AiVaultAgent[]): boolean {
  return agents.some((agent) => !LEGACY_SEARCH_AGENTS.includes(agent))
}

export function compatibleSearchAgents(
  agents: readonly AiVaultAgent[],
  status: Pick<
    AiVaultSearchStatus,
    | 'supportedAgents'
    | 'supportsQoderHistory'
    | 'supportsJcodeHistory'
    | 'dshHistory'
    | 'reasonixHistory'
  >,
  requestedAgents?: readonly AiVaultAgent[]
): AiVaultAgent[] {
  // Qoder's shipped capability also proves the earlier CodeBuddy and ZCode enum additions.
  const supported = new Set(
    status.supportedAgents ?? [
      ...LEGACY_SEARCH_AGENTS,
      ...(status.supportsQoderHistory === true ? ['codebuddy', 'zcode', 'qoder'] : []),
      ...(status.supportsJcodeHistory === true ? ['jcode'] : []),
      ...(status.dshHistory === true ? ['dsh'] : []),
      ...(status.reasonixHistory === true ? ['reasonix'] : []),
      // Explicit old-parser tags prove readability; DSH and Reasonix retain their shipped opt-ins.
      ...(requestedAgents ?? []).filter(
        (agent) =>
          agent !== 'dsh' &&
          agent !== 'reasonix' &&
          (agent !== 'qoder' || status.supportsQoderHistory !== false) &&
          (agent !== 'jcode' || status.supportsJcodeHistory !== false)
      )
    ]
  )
  return agents.filter((agent) => supported.has(agent))
}
