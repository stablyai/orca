import type { SkillFreshnessInstallation } from '../../../../shared/skill-freshness'

export type SkillGroupStatus = 'update-available' | 'cannot-update'

export type SkillLocationChip =
  | 'current'
  | 'unrecognized'
  | 'inaccessible'
  | 'duplicate'
  | 'external-link'
  | 'broken-link'
  | 'read-only'
  | 'in-a-repo'
  | 'plugin-cache'

export type SkillLocationRow = {
  id: string
  path: string
  chip: SkillLocationChip | null
}

export type SkillFreshnessGroupModel = {
  name: string
  status: SkillGroupStatus
  locations: SkillLocationRow[]
}

function locationChip(installation: SkillFreshnessInstallation): SkillLocationChip | null {
  // Why: a location's own status wins over its topology — "the contents don't
  // match" is more useful to the user than "it's a duplicate".
  if (installation.status === 'unrecognized') {
    return 'unrecognized'
  }
  if (installation.status === 'inaccessible') {
    return 'inaccessible'
  }
  switch (installation.topology) {
    case 'independent-copy':
      return 'duplicate'
    case 'external-link':
      return 'external-link'
    case 'broken-link':
      return 'broken-link'
    case 'read-only':
      return 'read-only'
    case 'repo-scope':
      return 'in-a-repo'
    case 'plugin-cache':
      return 'plugin-cache'
    case 'canonical-copy':
    case 'provider-alias':
      // Why: a supported location only needs a chip when it's already up to date,
      // to explain why the update won't touch it; the out-of-date main copy is bare.
      return installation.status === 'current' ? 'current' : null
  }
}

/**
 * Groups installations by skill for the update modal and derives each skill's
 * update disposition. Only skills with an out-of-date official copy are returned —
 * up-to-date, unrecognized-only, and unreadable-only skills have nothing to change
 * here, so they are omitted entirely.
 */
export function groupSkillFreshness(
  installations: readonly SkillFreshnessInstallation[],
  eligibleUpdateNames: readonly string[]
): SkillFreshnessGroupModel[] {
  const eligible = new Set(eligibleUpdateNames)
  const byName = new Map<string, SkillFreshnessInstallation[]>()
  for (const installation of installations) {
    const entries = byName.get(installation.name) ?? []
    entries.push(installation)
    byName.set(installation.name, entries)
  }
  const groups: SkillFreshnessGroupModel[] = []
  for (const [name, entries] of byName) {
    if (!entries.some((entry) => entry.status === 'outdated')) {
      continue
    }
    const locations = entries
      .map((entry) => ({ id: entry.id, path: entry.unresolvedPath, chip: locationChip(entry) }))
      .sort((left, right) => left.path.localeCompare(right.path, 'en'))
    groups.push({
      name,
      status: eligible.has(name) ? 'update-available' : 'cannot-update',
      locations
    })
  }
  return groups.sort((left, right) => left.name.localeCompare(right.name, 'en'))
}
