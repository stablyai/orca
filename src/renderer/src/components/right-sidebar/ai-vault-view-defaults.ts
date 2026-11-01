import {
  AI_VAULT_AGENTS,
  type AiVaultAgent,
  type AiVaultGroup,
  type AiVaultSearchSort,
  type AiVaultSort
} from '../../../../shared/ai-vault-types'
import { DEFAULT_AI_VAULT_SESSION_LIMIT, type AiVaultSessionLimit } from './ai-vault-session-limit'

// Share the default across initial state, adjustment count, and Reset view so they cannot diverge.
export const DEFAULT_AI_VAULT_HIDE_EMPTY_SESSIONS = false
export const DEFAULT_AI_VAULT_SORT: AiVaultSort = 'updated'
export const DEFAULT_AI_VAULT_SEARCH_SORT: AiVaultSearchSort = 'relevance'
export const DEFAULT_AI_VAULT_GROUP: AiVaultGroup = 'project'

// Sorts are uncounted: the bar shows them, so neither is a hidden adjustment.
export function countAiVaultViewAdjustments(options: {
  agents: readonly AiVaultAgent[]
  group: AiVaultGroup
  hideEmptySessions: boolean
  sessionLimit: AiVaultSessionLimit
}): number {
  // Agent swaps preserve length but still deviate from the all-enabled default.
  const allAgentsEnabled = AI_VAULT_AGENTS.every((agent) => options.agents.includes(agent))
  return (
    (allAgentsEnabled ? 0 : 1) +
    (options.group === DEFAULT_AI_VAULT_GROUP ? 0 : 1) +
    (options.hideEmptySessions === DEFAULT_AI_VAULT_HIDE_EMPTY_SESSIONS ? 0 : 1) +
    (options.sessionLimit === DEFAULT_AI_VAULT_SESSION_LIMIT ? 0 : 1)
  )
}
