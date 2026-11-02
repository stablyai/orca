import type {
  SkillBundleInstallResult,
  SkillBundleSkillResult
} from '../../../../shared/skill-bundle-install-contract'

export function skillBundleSkillNeedsRetry(skill: SkillBundleSkillResult): boolean {
  return (
    skill.status === 'failed' ||
    skill.status === 'cancelled' ||
    skill.placements.some(
      (placement) => placement.status === 'failed' || placement.status === 'skipped'
    )
  )
}

export function retryableSkillIds(result: SkillBundleInstallResult | null): Set<string> {
  return new Set(
    result?.skills.filter(skillBundleSkillNeedsRetry).map((skill) => skill.skillId) ?? []
  )
}
