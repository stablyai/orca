import type { ManagedSkillInstall } from '../../../../shared/skill-install-contract'
import type { DiscoveredSkill } from '../../../../shared/skills'

function skillScope(skill: DiscoveredSkill): ManagedSkillInstall['scope'] | null {
  return skill.sourceKind === 'home' ? 'global' : skill.sourceKind === 'repo' ? 'workspace' : null
}

export function matchingManagedSkillShareInstall(
  skills: readonly DiscoveredSkill[],
  installs: ManagedSkillInstall[]
): ManagedSkillInstall | null {
  if (skills.length === 0) {
    return null
  }
  if (skills.length === 1) {
    const scope = skillScope(skills[0])
    const matches = installs.filter(
      (install) =>
        install.name === skills[0].name &&
        install.scope === scope &&
        install.state !== 'missing' &&
        !install.bundleDigest
    )
    if (matches.length === 1) {
      return matches[0]
    }
    if (matches.length > 1) {
      return null
    }
  }
  const scope = skillScope(skills[0])
  if (!scope || skills.some((skill) => skillScope(skill) !== scope)) {
    return null
  }
  const selectedNames = new Set(skills.map((skill) => skill.name))
  const groups = new Map<string, ManagedSkillInstall[]>()
  for (const install of installs) {
    if (install.scope !== scope || install.state === 'missing' || !install.bundleDigest) {
      continue
    }
    const key = [
      install.packageId,
      install.versionId,
      install.destinationIdentity,
      install.bundleDigest
    ].join('\0')
    const group = groups.get(key) ?? []
    group.push(install)
    groups.set(key, group)
  }
  const matches = [...groups.values()].filter(
    (group) =>
      group.length === selectedNames.size &&
      group.every((install) => selectedNames.has(install.name)) &&
      new Set(group.map((install) => install.name)).size === group.length
  )
  return matches.length === 1 ? (matches[0][0] ?? null) : null
}
