import type { SkillLocationChip } from './skill-freshness-grouping'
import { translate } from '@/i18n/i18n'

export function chipLabel(chip: SkillLocationChip): string {
  switch (chip) {
    case 'current':
      return translate('auto.components.skills.SkillFreshnessRow.chipCurrent', 'Current')
    case 'unrecognized':
      return translate('auto.components.skills.SkillFreshnessRow.chipUnrecognized', 'Unrecognized')
    case 'inaccessible':
      return translate('auto.components.skills.SkillFreshnessRow.chipInaccessible', 'Inaccessible')
    case 'duplicate':
      return translate('auto.components.skills.SkillFreshnessRow.chipDuplicate', 'Duplicate')
    case 'external-link':
      return translate('auto.components.skills.SkillFreshnessRow.chipExternalLink', 'External link')
    case 'broken-link':
      return translate('auto.components.skills.SkillFreshnessRow.chipBrokenLink', 'Broken link')
    case 'read-only':
      return translate('auto.components.skills.SkillFreshnessRow.chipReadOnly', 'Read only')
    case 'in-a-repo':
      return translate('auto.components.skills.SkillFreshnessRow.chipInRepo', 'In a repo')
    case 'plugin-cache':
      return translate('auto.components.skills.SkillFreshnessRow.chipPluginCache', 'Plugin cache')
  }
}

// Why: chips describe only what a location *is*; the effect on the update
// command lives in the per-skill sentence, so the two never say it twice.
export function chipTooltip(chip: SkillLocationChip): string {
  switch (chip) {
    case 'current':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipCurrent',
        'This copy matches the current official version.'
      )
    case 'unrecognized':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipUnrecognized',
        'This copy doesn’t match any official version — it may be modified, or a different skill with the same name.'
      )
    case 'inaccessible':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipInaccessible',
        'Orca couldn’t read this copy (a permissions or file error).'
      )
    case 'duplicate':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipDuplicate',
        'A separate copy of this skill, installed apart from the main one.'
      )
    case 'external-link':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipExternalLink',
        'A shortcut pointing outside Orca’s skill folders.'
      )
    case 'broken-link':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipBrokenLink',
        'A shortcut to something that no longer exists.'
      )
    case 'read-only':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipReadOnly',
        'This copy is in a read-only location.'
      )
    case 'in-a-repo':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipInRepo',
        'This copy lives inside a project, not your global skills.'
      )
    case 'plugin-cache':
      return translate(
        'auto.components.skills.SkillFreshnessRow.tipPluginCache',
        'This copy is managed by a plugin.'
      )
  }
}
