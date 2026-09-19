import type { OrcadManagedDeployResult } from '../../../../shared/orcad-managed-runtime'
import { translate } from '@/i18n/i18n'

export function deploySuccessMessage(
  result: Exclude<OrcadManagedDeployResult, { outcome: 'deferred' }>
) {
  return result.outcome === 'already-current'
    ? translate(
        'auto.components.settings.ManagedOrcadServersSection.alreadyCurrent',
        'orcad {{value0}} is already current.',
        { value0: result.activeVersion }
      )
    : translate(
        'auto.components.settings.ManagedOrcadServersSection.deployComplete',
        'Activated orcad {{value0}}.',
        { value0: result.activeVersion }
      )
}
