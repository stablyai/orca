import type { DiscoveredSkill } from '../../../../shared/skills'

/** Share collapses lowercase names to satisfy publishing constraints; Delete uses null collision keys to keep distinct files. */
export type SkillSelectionPolicy = {
  isEligible: (skill: DiscoveredSkill) => boolean
  collisionKey: (skill: DiscoveredSkill) => string | null
  maxSelection?: number
}

function collisionKeys(
  skills: readonly DiscoveredSkill[],
  selectedIds: ReadonlySet<string>,
  policy: SkillSelectionPolicy
): Set<string> {
  const keys = new Set<string>()
  for (const skill of skills) {
    const key = selectedIds.has(skill.id) ? policy.collisionKey(skill) : null
    if (key !== null) {
      keys.add(key)
    }
  }
  return keys
}

/** How many rows "Select all" would end up holding. */
export function eligibleSkillSelectionCount(
  results: readonly DiscoveredSkill[],
  policy: SkillSelectionPolicy
): number {
  const keys = new Set<string>()
  let uncollapsed = 0
  for (const skill of results) {
    if (!policy.isEligible(skill)) {
      continue
    }
    const key = policy.collisionKey(skill)
    if (key === null) {
      uncollapsed += 1
      continue
    }
    keys.add(key)
  }
  const count = keys.size + uncollapsed
  return policy.maxSelection === undefined ? count : Math.min(count, policy.maxSelection)
}

export function addSelectableSkillResults(
  current: ReadonlySet<string>,
  skills: readonly DiscoveredSkill[],
  results: readonly DiscoveredSkill[],
  policy: SkillSelectionPolicy
): Set<string> {
  const next = new Set(current)
  const taken = collisionKeys(skills, current, policy)
  for (const skill of results) {
    if (policy.maxSelection !== undefined && next.size >= policy.maxSelection) {
      break
    }
    if (!policy.isEligible(skill)) {
      continue
    }
    const key = policy.collisionKey(skill)
    if (key !== null && taken.has(key)) {
      continue
    }
    next.add(skill.id)
    if (key !== null) {
      taken.add(key)
    }
  }
  return next
}

/** Drop missing/ineligible scan results, preserving selection identity when membership stays equal. */
export function retainedSkillSelection(
  current: Set<string>,
  skills: readonly DiscoveredSkill[],
  policy: SkillSelectionPolicy
): Set<string> {
  const next = new Set<string>()
  const taken = new Set<string>()
  for (const skill of skills) {
    const key = policy.collisionKey(skill)
    if (!current.has(skill.id) || !policy.isEligible(skill) || (key !== null && taken.has(key))) {
      continue
    }
    next.add(skill.id)
    if (key !== null) {
      taken.add(key)
    }
  }
  return next.size === current.size ? current : next
}
