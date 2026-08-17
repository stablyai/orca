import type { SkillCloudVersion } from '../../../../shared/skill-cloud-contract'
import type { SkillBundleManifestV1 } from '../../../../shared/skill-bundle-manifest'

export type ResolvedSkillShare = { shareId: string; version: SkillCloudVersion }

export function isSkillBundleVersion(
  version: SkillCloudVersion
): version is SkillCloudVersion & { manifest: SkillBundleManifestV1 } {
  return 'skills' in version.manifest
}

export function summarizeSkillShareVersion(version: SkillCloudVersion | undefined): {
  scriptCount: number
  executableCount: number
  fileCount: number
} {
  const files = version
    ? 'skills' in version.manifest
      ? version.manifest.skills.flatMap((skill) => skill.files)
      : version.manifest.files
    : []
  return {
    scriptCount: files.filter((file) => file.path.startsWith('scripts/')).length,
    executableCount: files.filter((file) => file.executable).length,
    fileCount: files.length
  }
}
