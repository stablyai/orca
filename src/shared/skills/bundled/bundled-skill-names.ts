import renames from './bundled-skill-renames.json'

const formerNames: Readonly<Record<string, readonly string[]>> = renames

export function bundledSkillNames(name: string): readonly string[] {
  const canonical =
    Object.keys(formerNames).find((candidate) => formerNames[candidate].includes(name)) ?? name
  return [...new Set([name, canonical, ...(formerNames[canonical] ?? [])])]
}

/** Older clients still match their requested spelling when paired with a newer host. */
export function requestedBundledSkillName(name: string, requested?: readonly string[]): string {
  if (!requested || requested.includes(name)) {
    return name
  }
  return formerNames[name]?.find((former) => requested.includes(former)) ?? name
}
