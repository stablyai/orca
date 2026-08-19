import type { DiscoveredSkill } from '../../../../shared/skills'
import { translate } from '@/i18n/i18n'

export function isSkillShareEligible(skill: DiscoveredSkill, local: boolean): boolean {
  return local && skill.installed && (skill.sourceKind === 'home' || skill.sourceKind === 'repo')
}

export function skillShareEligibilityReason(
  skill: DiscoveredSkill,
  local: boolean,
  duplicateNameSelected = false
): string | null {
  if (!local) {
    return translate(
      'auto.components.skills.SkillShareSelectionControls.01c5a15e06',
      'Open this skill on its owning machine to share it.'
    )
  }
  if (!skill.installed) {
    return translate(
      'auto.components.skills.SkillShareSelectionControls.01c5a15e07',
      'Install this skill before sharing it.'
    )
  }
  if (skill.sourceKind !== 'home' && skill.sourceKind !== 'repo') {
    return translate(
      'auto.components.skills.SkillShareSelectionControls.01c5a15e08',
      'Only home and workspace skills can be shared.'
    )
  }
  return duplicateNameSelected
    ? translate(
        'auto.components.skills.SkillShareSelectionControls.01c5a15e09',
        'A skill with this name is already selected from another source.'
      )
    : null
}

function shareSkillNameKey(skill: DiscoveredSkill): string {
  return skill.name.toLocaleLowerCase('en-US')
}

export function selectedShareSkillNameKeys(
  skills: readonly DiscoveredSkill[],
  selectedIds: ReadonlySet<string>
): Set<string> {
  return new Set(
    skills.filter((skill) => selectedIds.has(skill.id)).map((skill) => shareSkillNameKey(skill))
  )
}

/** How many rows "Select all" would end up holding — duplicate names collapse to
 *  one, so the count has to dedup the same way the selection itself does. */
export function eligibleShareSkillCount(
  results: readonly DiscoveredSkill[],
  local: boolean
): number {
  const names = new Set<string>()
  for (const skill of results) {
    if (isSkillShareEligible(skill, local)) {
      names.add(shareSkillNameKey(skill))
    }
  }
  return names.size
}

export function addShareableSkillResults(
  current: ReadonlySet<string>,
  skills: readonly DiscoveredSkill[],
  results: readonly DiscoveredSkill[],
  local: boolean
): Set<string> {
  const next = new Set(current)
  const selectedNames = selectedShareSkillNameKeys(skills, current)
  for (const skill of results) {
    const name = shareSkillNameKey(skill)
    if (!isSkillShareEligible(skill, local) || selectedNames.has(name)) {
      continue
    }
    next.add(skill.id)
    selectedNames.add(name)
  }
  return next
}

export function retainedShareableSkillSelection(
  current: Set<string>,
  skills: readonly DiscoveredSkill[],
  local: boolean
): Set<string> {
  const next = new Set<string>()
  const names = new Set<string>()
  for (const skill of skills) {
    const name = shareSkillNameKey(skill)
    if (!current.has(skill.id) || !isSkillShareEligible(skill, local) || names.has(name)) {
      continue
    }
    next.add(skill.id)
    names.add(name)
  }
  return next.size === current.size ? current : next
}

export function updatedSkillSelection(
  current: ReadonlySet<string>,
  skillId: string,
  selected: boolean
): Set<string> {
  const next = new Set(current)
  if (selected) {
    next.add(skillId)
  } else {
    next.delete(skillId)
  }
  return next
}
