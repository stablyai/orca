import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function skillInstallManagementCopy(t: Translate = translate) {
  return {
    title: t('auto.components.skills.SkillInstallManagementDialog.44d118a8f7', 'Installed by Orca'),
    description: t(
      'auto.components.skills.SkillInstallManagementDialog.3677ae58e7',
      'Skills Orca installed from a link. Reinstall, go back to an earlier version, or remove them.'
    ),
    localMachine: t(
      'auto.components.skills.SkillInstallManagementDialog.6cb1fbe039',
      'This computer'
    ),
    ssh: t('auto.components.skills.SkillInstallManagementDialog.176fef9516', '· SSH'),
    disconnected: t(
      'auto.components.skills.SkillInstallManagementDialog.0900db719a',
      '— disconnected'
    ),
    noInstalls: t(
      'auto.components.skills.SkillInstallManagementDialog.64c71cf7b9',
      'Orca has not installed any skills on this machine yet.'
    ),
    bundleResult: (installed: number, updated: number, keptLocal: number) =>
      t(
        'auto.components.skills.SkillInstallManagementDialog.dab29e4b54',
        '{{installed}} installed · {{updated}} updated · {{keptLocal}} kept local',
        { installed, updated, keptLocal }
      ),
    close: t('auto.components.skills.SkillInstallManagementDialog.8095927ff3', 'Close')
  }
}
