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

const QODER_SEARCH_AGENTS: readonly AiVaultAgent[] = ['codebuddy', 'zcode', 'qoder']

export function needsSearchAgentNegotiation(agents: readonly AiVaultAgent[]): boolean {
  return agents.some((agent) => !LEGACY_SEARCH_AGENTS.includes(agent))
}

export function compatibleSearchAgents(
  agents: readonly AiVaultAgent[],
  status: Pick<
    AiVaultSearchStatus,
    'supportedAgents' | 'supportsQoderHistory' | 'supportsJcodeHistory' | 'dshHistory'
  >,
  requestedDecoderAgents: readonly AiVaultAgent[] = []
): AiVaultAgent[] {
  // Qoder's shipped capability also proves the earlier CodeBuddy and ZCode enum additions.
  const supported = new Set(
    status.supportedAgents ?? [
      ...LEGACY_SEARCH_AGENTS,
      ...(status.supportsQoderHistory === true ? QODER_SEARCH_AGENTS : []),
      ...(status.supportsJcodeHistory === true ? ['jcode'] : []),
      ...(status.dshHistory === true ? ['dsh'] : []),
      // An explicit decoder tag proves only providers whose legacy flag is omitted.
      ...requestedDecoderAgents.filter((agent) => {
        if (agent === 'dsh') {
          return false
        }
        if (QODER_SEARCH_AGENTS.includes(agent)) {
          return status.supportsQoderHistory === undefined
        }
        if (agent === 'jcode') {
          return status.supportsJcodeHistory === undefined
        }
        return true
      })
    ]
  )
  return agents.filter((agent) => supported.has(agent))
}
