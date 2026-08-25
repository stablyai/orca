import type { DiscoveredSkill } from '../../../../shared/skills'
import { translate } from '@/i18n/i18n'
import {
  addSelectableSkillResults,
  eligibleSkillSelectionCount,
  retainedSkillSelection,
  type SkillSelectionPolicy
} from './skill-selection'

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

const SHARE_SELECTION_POLICY_LOCAL: SkillSelectionPolicy = {
  isEligible: (skill) => isSkillShareEligible(skill, true),
  collisionKey: shareSkillNameKey
}

const SHARE_SELECTION_POLICY_REMOTE: SkillSelectionPolicy = {
  isEligible: () => false,
  collisionKey: shareSkillNameKey
}

function sharePolicy(local: boolean): SkillSelectionPolicy {
  return local ? SHARE_SELECTION_POLICY_LOCAL : SHARE_SELECTION_POLICY_REMOTE
}

export function eligibleShareSkillCount(
  results: readonly DiscoveredSkill[],
  local: boolean
): number {
  return eligibleSkillSelectionCount(results, sharePolicy(local))
}

export function addShareableSkillResults(
  current: ReadonlySet<string>,
  skills: readonly DiscoveredSkill[],
  results: readonly DiscoveredSkill[],
  local: boolean
): Set<string> {
  return addSelectableSkillResults(current, skills, results, sharePolicy(local))
}

export function retainedShareableSkillSelection(
  current: Set<string>,
  skills: readonly DiscoveredSkill[],
  local: boolean
): Set<string> {
  return retainedSkillSelection(current, skills, sharePolicy(local))
}

export function updatedSkillSelection(
  current: ReadonlySet<string>,
  skillId: string,
  selected: boolean,
  maxSelection?: number
): Set<string> {
  const next = new Set(current)
  if (selected && (maxSelection === undefined || next.size < maxSelection)) {
    next.add(skillId)
  } else {
    next.delete(skillId)
  }
  return next
}
