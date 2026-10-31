import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { getExecutionHostLabel, type ExecutionHostId } from '../../../../shared/execution-host'
import type { AiVaultHostScopeOption } from './ai-vault-host-scope'

/** Use host-menu names to distinguish cross-host copies; return null when all hits share a host. */
export function aiVaultSearchHitHostLabels(
  hits: readonly Pick<AiVaultSession, 'executionHostId'>[],
  hostOptions: readonly AiVaultHostScopeOption[]
): ReadonlyMap<ExecutionHostId, string> | null {
  const hostIds = new Set(hits.map((hit) => hit.executionHostId))
  if (hostIds.size < 2) {
    return null
  }
  const optionLabels = new Map<string, string>(
    hostOptions.map((option) => [option.id, option.label])
  )
  return new Map([...hostIds].map((id) => [id, optionLabels.get(id) ?? getExecutionHostLabel(id)]))
}
