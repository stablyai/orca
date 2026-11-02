import type { SkillInstallResult } from '../../../../shared/skill-install-contract'
import { translate } from '@/i18n/i18n'

export function skillInstallResultLabel(result: SkillInstallResult): string {
  switch (result.status) {
    case 'installed':
      return translate('auto.components.skills.installResult.installed', 'Installed and verified.')
    case 'updated':
      return translate('auto.components.skills.installResult.updated', 'Updated and verified.')
    case 'unchanged':
      return translate(
        'auto.components.skills.installResult.unchanged',
        'This exact version is already installed.'
      )
    case 'partial':
      return translate(
        'auto.components.skills.installResult.partial',
        'Installed, but one or more agent placements need attention.'
      )
    case 'removed':
      return translate('auto.components.skills.installResult.removed', 'Removed.')
    case 'cancelled':
      return translate('auto.components.skills.installResult.cancelled', 'Installation cancelled.')
    case 'conflict':
    case 'failed':
      return translate(
        'auto.components.skills.installResult.incomplete',
        'Installation did not complete.'
      )
  }
}
