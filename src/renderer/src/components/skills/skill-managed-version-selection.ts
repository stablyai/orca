import type { SkillCloudVersion } from '../../../../shared/skill-cloud-contract'

export function retainManagedSkillVersion(
  versions: readonly SkillCloudVersion[],
  current: string
): string {
  return versions.some((version) => version.versionId === current)
    ? current
    : (versions[0]?.versionId ?? '')
}
