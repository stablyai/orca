import type { SkillCloudVersion } from '../../../../../shared/skills/sharing/skill-cloud-contract'
import type { SkillBundleManifestV1 } from '../../../../../shared/skills/packages/skill-bundle-manifest'

export type ResolvedSkillShare = { shareId: string; version: SkillCloudVersion }

export function isSkillBundleVersion(
  version: SkillCloudVersion
): version is SkillCloudVersion & { manifest: SkillBundleManifestV1 } {
  return 'skills' in version.manifest
}
