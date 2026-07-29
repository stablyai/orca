import {
  isSkillCopyNeedingAttention,
  type SkillFreshnessInstallation
} from '../../../../shared/skill-freshness'

export type SkillGroupStatus = 'update-available' | 'cannot-update'

export type SkillLocationChip =
  | 'current'
  | 'newer'
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

export function locationChip(installation: SkillFreshnessInstallation): SkillLocationChip | null {
  if (installation.status === 'unrecognized' && installation.topology === 'plugin-cache') {
    return 'plugin-cache'
  }
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
      // Why: a supported location only needs a chip when the update won't touch it —
      // already current, or ahead of what this build knows. The out-of-date main copy
      // is bare, and 'newer' is what keeps a bare chip meaning "behind, and fixable":
      // reinstalling a copy that is ahead would quietly roll the user back.
      if (installation.status === 'current') {
        return 'current'
      }
      return installation.status === 'newer-known' ? 'newer' : null
  }
}

/**
 * Groups installations by skill for the review modal and derives each skill's
 * update disposition. A skill appears when a copy is out of date, or when a copy is
 * wrong in a way the update cannot fix — an edited copy, one Orca could not read.
 *
 * That second half is what the badge already reports: it turns amber and offers
 * Details, and Details opens this modal. Returning only out-of-date skills left that
 * modal saying every skill was up to date over an empty list, contradicting the badge
 * that sent the user there. Skills where every copy is current are still omitted, as
 * is a plugin's own copy of a same-named skill, which is not the user's to fix.
 *
 * `alwaysIncludeNames` overrides that filter. A successful update makes every
 * targeted skill current, which would otherwise drop its row the instant the
 * re-scan lands — the dialog passes the running/finished run's names so the same
 * rows stay put from "update available" through to the result.
 */
export function groupSkillFreshness(
  installations: readonly SkillFreshnessInstallation[],
  eligibleUpdateNames: readonly string[],
  alwaysIncludeNames: readonly string[] = []
): SkillFreshnessGroupModel[] {
  const eligible = new Set(eligibleUpdateNames)
  const pinned = new Set(alwaysIncludeNames)
  const byName = new Map<string, SkillFreshnessInstallation[]>()
  for (const installation of installations) {
    const entries = byName.get(installation.name) ?? []
    entries.push(installation)
    byName.set(installation.name, entries)
  }
  const groups: SkillFreshnessGroupModel[] = []
  for (const [name, entries] of byName) {
    if (
      !pinned.has(name) &&
      !entries.some((entry) => entry.status === 'outdated' || isSkillCopyNeedingAttention(entry))
    ) {
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
