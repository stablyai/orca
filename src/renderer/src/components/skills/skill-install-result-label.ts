import type { SkillInstallResult } from '../../../../shared/skill-install-contract'

export function skillInstallResultLabel(result: SkillInstallResult): string {
  switch (result.status) {
    case 'installed':
      return 'Installed and verified.'
    case 'updated':
      return 'Updated and verified.'
    case 'unchanged':
      return 'This exact version is already installed.'
    case 'partial':
      return 'Installed, but one or more agent placements need attention.'
    case 'removed':
      return 'Removed.'
    case 'cancelled':
      return 'Installation cancelled.'
    case 'conflict':
    case 'failed':
      return 'Installation did not complete.'
  }
}
