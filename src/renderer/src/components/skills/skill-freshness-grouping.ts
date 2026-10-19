import {
  isOrcaSkillLockSource,
  isSkillCopyNeedingAttention,
  skillPlacementParticipatesInGlobalFreshness,
  type SkillFreshnessInstallation
} from '../../../../shared/skill-freshness'

export type SkillGroupStatus = 'update-available' | 'cannot-update'

export type SkillLocationChip =
  | 'current'
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
  /** False for a project-owned copy: listed for visibility, but never judged, so it
   * cannot be the reason a skill was skipped. */
  participatesInGlobalFreshness: boolean
}

export type SkillFreshnessGroupModel = {
  name: string
  status: SkillGroupStatus
  /** The skills.sh lock says Orca installed this name, so its update is preselected. */
  orcaOwned: boolean
  lockSource: string | null
  locations: SkillLocationRow[]
}

export function locationChip(installation: SkillFreshnessInstallation): SkillLocationChip | null {
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
      // Why: the out-of-date copy the update rewrites is the bare one.
      return installation.status === 'current' ? 'current' : null
  }
}

/**
 * Groups installations by skill for the review modal and derives each skill's
 * update disposition. A skill appears when a copy is out of date, or when a copy is
 * wrong in a way the update cannot fix — a link out of tree, one Orca could not read.
 *
 * That second half is what the badge already reports: it turns amber and offers
 * Details, and Details opens this modal. Returning only out-of-date skills left that
 * modal saying every skill was up to date over an empty list, contradicting the badge
 * that sent the user there. Skills where every copy is current are still omitted, as
 * is a plugin's or a project's own copy — neither is the user's to fix through the global
 * update. Skills Orca installed sort first, since only they are preselected.
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
    // Why: the inclusion test only consults placements the global update can reach, so a
    // skill whose only finding is a project's or plugin's own copy raises no row at all — a
    // "Skipped" row would assert Orca considered an update it never could. Locations below
    // are still listed in full, so such a copy stays visible whenever some other placement
    // earns the group.
    if (
      !pinned.has(name) &&
      !entries
        .filter(skillPlacementParticipatesInGlobalFreshness)
        .some((entry) => entry.status === 'outdated' || isSkillCopyNeedingAttention(entry))
    ) {
      continue
    }
    const locations = entries
      .map((entry) => ({
        id: entry.id,
        path: entry.unresolvedPath,
        chip: locationChip(entry),
        participatesInGlobalFreshness: skillPlacementParticipatesInGlobalFreshness(entry)
      }))
      .sort((left, right) => left.path.localeCompare(right.path, 'en'))
    const lockSource = entries[0]?.lockSource ?? null
    groups.push({
      name,
      status: eligible.has(name) ? 'update-available' : 'cannot-update',
      orcaOwned: isOrcaSkillLockSource(lockSource),
      lockSource,
      locations
    })
  }
  return groups.sort(
    (left, right) =>
      Number(right.orcaOwned) - Number(left.orcaOwned) || left.name.localeCompare(right.name, 'en')
  )
}
