import type {
  BundledSkillLeaveReason,
  BundledSkillLocationPlan
} from '../../../../shared/skill-freshness'
import { translate } from '@/i18n/i18n'

/** What the install does to one location, as a short chip beside its path. */
export function planLocationLabel(location: BundledSkillLocationPlan): string {
  switch (location.action) {
    case 'keep':
      return translate('auto.components.skills.skill.plan.location.copy.keep', 'No change')
    case 'install':
      return translate('auto.components.skills.skill.plan.location.copy.install', 'Will install')
    case 'update':
      return translate('auto.components.skills.skill.plan.location.copy.update', 'Will update')
    case 'link':
      return translate('auto.components.skills.skill.plan.location.copy.link', 'Will link')
    case 'replace':
      return translate('auto.components.skills.skill.plan.location.copy.replace', 'Will replace')
    case 'leave':
      return leaveReasonLabel(location.reason ?? 'unreadable')
  }
}

function leaveReasonLabel(reason: BundledSkillLeaveReason): string {
  switch (reason) {
    case 'local-changes':
      return translate(
        'auto.components.skills.skill.plan.location.copy.localChangesLabel',
        'Local changes'
      )
    case 'not-installed-by-orca':
      return translate('auto.components.skills.SkillUpdateRow.notFromOrca', 'Not from Orca')
    case 'link-not-managed':
      return translate(
        'auto.components.skills.skill.plan.location.copy.linkNotManagedLabel',
        'Unmanaged link'
      )
    case 'name-in-use':
      return translate(
        'auto.components.skills.skill.plan.location.copy.nameInUseLabel',
        'Name in use'
      )
    case 'read-only':
      return translate('auto.components.skills.SkillFreshnessRow.chipReadOnly', 'Read only')
    case 'unreadable':
      return translate('auto.components.skills.SkillFreshnessRow.chipInaccessible', 'Inaccessible')
  }
}

/** Why the install leaves a location as it is; one sentence per plan reason. */
export function leaveReasonSentence(reason: BundledSkillLeaveReason): string {
  switch (reason) {
    case 'local-changes':
      return translate(
        'auto.components.skills.skill.plan.location.copy.localChanges',
        'This copy has changes Orca didn’t make, so the update leaves it as it is. Remove it, then reinstall the skill to get Orca’s version.'
      )
    case 'not-installed-by-orca':
      return translate(
        'auto.components.skills.skill.plan.location.copy.notInstalledByOrca',
        'Orca didn’t install this copy, so the update leaves it as it is. Remove it, then reinstall the skill to use Orca’s version.'
      )
    case 'link-not-managed':
      return translate(
        'auto.components.skills.skill.plan.location.copy.linkNotManaged',
        'This is a link Orca didn’t create, so the update leaves it as it is.'
      )
    case 'name-in-use':
      return translate(
        'auto.components.skills.skill.plan.location.copy.nameInUse',
        'Another file or folder already uses this skill’s name, so the update leaves it as it is.'
      )
    case 'read-only':
      return translate(
        'auto.components.skills.skill.plan.location.copy.readOnly',
        'This location is read-only, so the update can’t change it. Change its permissions to let Orca update it.'
      )
    case 'unreadable':
      return translate(
        'auto.components.skills.skill.plan.location.copy.unreadable',
        'Orca couldn’t read this copy, so the update leaves it as it is.'
      )
  }
}
