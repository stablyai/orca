import { translate } from '@/i18n/i18n'

export function skillInstallManagementCopy() {
  return {
    title: translate(
      'auto.components.skills.SkillInstallManagementDialog.44d118a8f7',
      'Installed by Orca'
    ),
    description: translate(
      'auto.components.skills.SkillInstallManagementDialog.3677ae58e7',
      'Skills Orca installed from a link. Reinstall, go back to an earlier version, or remove them.'
    ),
    localMachine: translate(
      'auto.components.skills.SkillInstallManagementDialog.6cb1fbe039',
      'This computer'
    ),
    ssh: translate('auto.components.skills.SkillInstallManagementDialog.176fef9516', '· SSH'),
    disconnected: translate(
      'auto.components.skills.SkillInstallManagementDialog.0900db719a',
      '— disconnected'
    ),
    noInstalls: translate(
      'auto.components.skills.SkillInstallManagementDialog.64c71cf7b9',
      'Orca has not installed any skills on this machine yet.'
    ),
    bundleResult: (installed: number, updated: number, keptLocal: number) =>
      translate(
        'auto.components.skills.SkillInstallManagementDialog.dab29e4b54',
        '{{installed}} installed · {{updated}} updated · {{keptLocal}} kept local',
        { installed, updated, keptLocal }
      ),
    close: translate('auto.components.skills.SkillInstallManagementDialog.8095927ff3', 'Close')
  }
}
