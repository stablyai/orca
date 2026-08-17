import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoverySource
} from '../../../../shared/skills'

export type SkillSourceStatus = 'scanned' | 'missing' | 'remote-repo' | 'unavailable'

export type SkillSourceInventoryEntry = {
  source: SkillDiscoverySource
  skillCount: number
  status: SkillSourceStatus
}

function ownsSkill(source: SkillDiscoverySource, skill: DiscoveredSkill): boolean {
  // Why: a symlinked skill is deduped to one row but keeps every root that
  // reached it, so counting only `rootPath` would zero out the co-owning roots.
  return skill.rootPath === source.path || (skill.rootPaths?.includes(source.path) ?? false)
}

function sourceStatus(source: SkillDiscoverySource): SkillSourceStatus {
  if (source.exists) {
    return 'scanned'
  }
  if (source.skippedReason === 'missing' || source.skippedReason === 'remote-repo') {
    return source.skippedReason
  }
  return 'unavailable'
}

export function summarizeSkillSources(
  result: SkillDiscoveryResult | null
): SkillSourceInventoryEntry[] {
  if (!result) {
    return []
  }
  return result.sources.map((source) => ({
    source,
    skillCount: result.skills.filter((skill) => ownsSkill(source, skill)).length,
    status: sourceStatus(source)
  }))
}

export function scannedSkillSourceCount(entries: readonly SkillSourceInventoryEntry[]): number {
  return entries.filter((entry) => entry.status === 'scanned').length
}
