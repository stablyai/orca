import type { SkillInstallResult } from '../../../../shared/skill-install-contract'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function skillInstallResultLabel(
  result: SkillInstallResult,
  t: Translate = translate
): string {
  switch (result.status) {
    case 'installed':
      return t('auto.components.skills.installResult.installed', 'Installed and verified.')
    case 'updated':
      return t('auto.components.skills.installResult.updated', 'Updated and verified.')
    case 'unchanged':
      return t(
        'auto.components.skills.installResult.unchanged',
        'This exact version is already installed.'
      )
    case 'partial':
      return t(
        'auto.components.skills.installResult.partial',
        'Installed, but one or more agent placements need attention.'
      )
    case 'removed':
      return t('auto.components.skills.installResult.removed', 'Removed.')
    case 'cancelled':
      return t('auto.components.skills.installResult.cancelled', 'Installation cancelled.')
    case 'conflict':
    case 'failed':
      return t('auto.components.skills.installResult.incomplete', 'Installation did not complete.')
  }
}
