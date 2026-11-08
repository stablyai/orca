import type { SkillCloudVersion } from '../../../../shared/skill-cloud-contract'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { groupInstallState, type SkillManagedInstallGroup } from './skill-managed-install-groups'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'

const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
}

function formatDate(value: string, intlLocale?: string): string | null {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? null
    : uiDateTimeFormat(DATE_OPTIONS, intlLocale).format(parsed)
}

/** Before a bundle package loads, derive its title from the skills installed on disk. */
export function managedInstallTitle(
  group: SkillManagedInstallGroup,
  t: Translate = translate
): string {
  const [first, ...rest] = group.installs
  if (!first) {
    return group.packageId
  }
  return rest.length === 0
    ? first.name
    : t('auto.components.skills.managedInstall.titleMore', '{{name}} +{{count}}', {
        name: first.name,
        count: rest.length
      })
}

export function managedInstallScopeLabel(
  group: SkillManagedInstallGroup,
  t: Translate = translate
): string {
  return group.installs[0]?.scope === 'workspace'
    ? t('auto.components.skills.managedInstall.scopeWorkspace', 'This workspace')
    : t('auto.components.skills.managedInstall.scopeGlobal', 'Everywhere')
}

export function managedInstalledOnLabel(
  group: SkillManagedInstallGroup,
  t: Translate = translate,
  intlLocale?: string
): string | null {
  const installedAt = group.installs[0]?.installedAt
  const date = installedAt ? formatDate(installedAt, intlLocale) : null
  return date
    ? t('auto.components.skills.managedInstall.installedOn', 'Installed {{date}}', { date })
    : null
}

/** Leave unchanged installs quiet; label only states the user can act on. */
export function managedInstallStateNote(
  group: SkillManagedInstallGroup,
  t: Translate = translate
): string | null {
  const state = groupInstallState(group)
  if (state === 'modified') {
    return t('auto.components.skills.managedInstall.stateEdited', 'Edited after installing')
  }
  return state === 'missing'
    ? t('auto.components.skills.managedInstall.stateMissing', 'Files are missing')
    : null
}

export function managedSkillStateNote(state: string, t: Translate = translate): string | null {
  if (state === 'modified') {
    return t('auto.components.skills.managedInstall.skillEdited', 'Edited')
  }
  return state === 'missing'
    ? t('auto.components.skills.managedInstall.skillMissing', 'Missing')
    : null
}

/** Identify opaque versions by date and mark the installed one without repeating its label. */
export function managedVersionLabel(
  version: SkillCloudVersion,
  installedVersionId: string,
  t: Translate = translate,
  intlLocale?: string
): string {
  const date =
    formatDate(version.createdAt, intlLocale) ??
    t('auto.components.skills.SkillRow.updatedUnknown', 'No date')
  return version.versionId === installedVersionId
    ? t('auto.components.skills.managedInstall.versionCurrent', '{{date}} (installed)', {
        date
      })
    : date
}
