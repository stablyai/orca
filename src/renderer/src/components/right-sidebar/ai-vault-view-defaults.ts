import {
  AI_VAULT_AGENTS,
  type AiVaultAgent,
  type AiVaultGroup,
  type AiVaultSort
} from '../../../../shared/ai-vault-types'

// Why: hide-empty used to default true; keep initial state, badge count, and Reset view
// on one constant so a default flip cannot leave Reset pointing at the old value.
export const DEFAULT_AI_VAULT_HIDE_EMPTY_SESSIONS = false
export const DEFAULT_AI_VAULT_SORT: AiVaultSort = 'updated'
export const DEFAULT_AI_VAULT_GROUP: AiVaultGroup = 'project'

export function countAiVaultViewAdjustments(options: {
  agents: readonly AiVaultAgent[]
  sort: AiVaultSort
  group: AiVaultGroup
  hideEmptySessions: boolean
}): number {
  // Why: count by membership, not length — an agent swap keeps the array length but
  // still deviates from the default of every agent enabled.
  const allAgentsEnabled = AI_VAULT_AGENTS.every((agent) => options.agents.includes(agent))
  return (
    (allAgentsEnabled ? 0 : 1) +
    (options.sort === DEFAULT_AI_VAULT_SORT ? 0 : 1) +
    (options.group === DEFAULT_AI_VAULT_GROUP ? 0 : 1) +
    (options.hideEmptySessions === DEFAULT_AI_VAULT_HIDE_EMPTY_SESSIONS ? 0 : 1)
  )
}
