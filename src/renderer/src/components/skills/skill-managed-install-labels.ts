import type { SkillCloudVersion } from '../../../../shared/skill-cloud-contract'
import { translate } from '@/i18n/i18n'
import { groupInstallState, type SkillManagedInstallGroup } from './skill-managed-install-groups'

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})

function formatDate(value: string): string | null {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : dateFormatter.format(parsed)
}

/** Bundles have no name until the package loads, so the row names itself after
 *  what it actually put on disk. */
export function managedInstallTitle(group: SkillManagedInstallGroup): string {
  const [first, ...rest] = group.installs
  if (!first) {
    return group.packageId
  }
  return rest.length === 0
    ? first.name
    : translate('auto.components.skills.managedInstall.titleMore', '{{name}} +{{count}}', {
        name: first.name,
        count: rest.length
      })
}

export function managedInstallScopeLabel(group: SkillManagedInstallGroup): string {
  return group.installs[0]?.scope === 'workspace'
    ? translate('auto.components.skills.managedInstall.scopeWorkspace', 'This workspace')
    : translate('auto.components.skills.managedInstall.scopeGlobal', 'Everywhere')
}

export function managedInstalledOnLabel(group: SkillManagedInstallGroup): string | null {
  const installedAt = group.installs[0]?.installedAt
  const date = installedAt ? formatDate(installedAt) : null
  return date
    ? translate('auto.components.skills.managedInstall.installedOn', 'Installed {{date}}', { date })
    : null
}

/**
 * `unchanged` is the normal case and saying so on every row is noise, so only
 * the two states a person can act on get words.
 */
export function managedInstallStateNote(group: SkillManagedInstallGroup): string | null {
  const state = groupInstallState(group)
  if (state === 'modified') {
    return translate('auto.components.skills.managedInstall.stateEdited', 'Edited after installing')
  }
  return state === 'missing'
    ? translate('auto.components.skills.managedInstall.stateMissing', 'Files are missing')
    : null
}

export function managedSkillStateNote(state: string): string | null {
  if (state === 'modified') {
    return translate('auto.components.skills.managedInstall.skillEdited', 'Edited')
  }
  return state === 'missing'
    ? translate('auto.components.skills.managedInstall.skillMissing', 'Missing')
    : null
}

/** Version ids are opaque, so the date does the identifying and the installed
 *  one is marked rather than spelled out a second time. */
export function managedVersionLabel(
  version: SkillCloudVersion,
  installedVersionId: string
): string {
  const date =
    formatDate(version.createdAt) ??
    translate('auto.components.skills.SkillRow.updatedUnknown', 'No date')
  return version.versionId === installedVersionId
    ? translate('auto.components.skills.managedInstall.versionCurrent', '{{date}} (installed)', {
        date
      })
    : date
}
