import type { DiscoveredSkill, SkillSourceKind } from '../../../shared/skills'

export const GLOBAL_AGENT_SKILL_SOURCE_KINDS = [
  'home'
] as const satisfies readonly SkillSourceKind[]

export type InstalledAgentSkillMatchOptions = {
  sourceKinds?: readonly SkillSourceKind[]
}

export function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase()
}

/** Last path segment, tolerant of both `/` and `\` separators. */
function basenameFromPath(pathValue: string): string {
  return pathValue.split(/[\\/]/).findLast(Boolean) ?? pathValue
}

export function hasInstalledAgentSkill(
  skills: readonly DiscoveredSkill[],
  skillName: string,
  options: InstalledAgentSkillMatchOptions = {}
): boolean {
  return hasInstalledAgentSkillNamed(skills, [skillName], options)
}

/** Matches on skill name or install-directory basename, since a renamed
 *  directory and a renamed front-matter name both still mean "installed". */
export function hasInstalledAgentSkillNamed(
  skills: readonly DiscoveredSkill[],
  skillNames: readonly string[],
  options: InstalledAgentSkillMatchOptions = {}
): boolean {
  const expected = new Set(skillNames.map(normalizeSkillName))
  return skills.some((skill) => {
    if (!skill.installed) {
      return false
    }
    if (options.sourceKinds && !options.sourceKinds.includes(skill.sourceKind)) {
      return false
    }
    return (
      expected.has(normalizeSkillName(skill.name)) ||
      expected.has(normalizeSkillName(basenameFromPath(skill.directoryPath)))
    )
  })
}
