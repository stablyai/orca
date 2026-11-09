import type { SkillCloudOwnedShare } from '../../../../shared/skill-cloud-contract'

export type SkillSharedLinkGroup = {
  share: SkillCloudOwnedShare
  olderShares: SkillCloudOwnedShare[]
}

/**
 * One row per package once the cloud keeps one link per package; its other live links stay
 * listed so none is stopped silently. Clouds without canonical links keep one row per link.
 */
export function skillSharedLinkGroups(
  shares: readonly SkillCloudOwnedShare[]
): SkillSharedLinkGroup[] {
  if (!shares.some((share) => share.canonical !== undefined)) {
    return shares.map((share) => ({ share, olderShares: [] }))
  }
  const byPackage = new Map<string, SkillCloudOwnedShare[]>()
  for (const share of shares) {
    byPackage.set(share.packageId, [...(byPackage.get(share.packageId) ?? []), share])
  }
  return [...byPackage.values()].map((links) => {
    // Shares arrive newest first, so a package without a canonical link shows its newest.
    const share = links.find((link) => link.canonical) ?? links[0]!
    return { share, olderShares: links.filter((link) => link !== share) }
  })
}
