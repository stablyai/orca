import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getTranslatedExecutionHostLabel } from '../../../sidebar/execution-host-label'
import { aiVaultHostScopeLabel, type AiVaultHostScopeOption } from '../scope/ai-vault-host-scope'

/** Use host-menu names to distinguish cross-host copies; return null when all hits share a host. */
export function aiVaultSearchHitHostLabels(
  hits: readonly Pick<AiVaultSession, 'executionHostId'>[],
  hostOptions: readonly AiVaultHostScopeOption[],
  t: Translate = translate
): ReadonlyMap<ExecutionHostId, string> | null {
  const hostIds = new Set(hits.map((hit) => hit.executionHostId))
  if (hostIds.size < 2) {
    return null
  }
  const optionLabels = new Map(
    hostOptions.map((option) => [option.id, aiVaultHostScopeLabel(option, t)])
  )
  return new Map(
    [...hostIds].map((id) => [id, optionLabels.get(id) ?? getTranslatedExecutionHostLabel(id, t)])
  )
}
