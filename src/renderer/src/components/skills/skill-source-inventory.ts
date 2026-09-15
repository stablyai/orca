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
  return skill.rootPath === source.path || (skill.rootPaths?.includes(source.path) ?? false)
}

function sourceStatus(source: SkillDiscoverySource): SkillSourceStatus {
  // Why before `exists`: an unanswered root reports `exists: true` because the
  // host could not prove otherwise. Reading that as `scanned` presented a root
  // nobody walked as a successful scan, and its retained skills as its full count.
  if (source.skippedReason === 'unavailable') {
    return 'unavailable'
  }
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
  if (!result || result.sources.length === 0) {
    return []
  }
  // With no repeated skill traversal, the direct count needs no index.
  if (result.sources.length === 1 || result.skills.length === 0) {
    return result.sources.map((source) => ({
      source,
      skillCount: result.skills.filter((skill) => ownsSkill(source, skill)).length,
      status: sourceStatus(source)
    }))
  }
  const counts = new Map(
    result.sources.map((source) => [source.path, { count: 0, lastSkillIndex: -1 }])
  )
  const countRoot = (rootPath: string, skillIndex: number): void => {
    const count = counts.get(rootPath)
    // Symlinked skills can name one owning root more than once.
    if (count && count.lastSkillIndex !== skillIndex) {
      count.count++
      count.lastSkillIndex = skillIndex
    }
  }
  for (let index = 0; index < result.skills.length; index++) {
    const skill = result.skills[index]
    countRoot(skill.rootPath, index)
    for (const rootPath of skill.rootPaths ?? []) {
      countRoot(rootPath, index)
    }
  }
  return result.sources.map((source) => ({
    source,
    skillCount: counts.get(source.path)?.count ?? 0,
    status: sourceStatus(source)
  }))
}

export function scannedSkillSourceCount(entries: readonly SkillSourceInventoryEntry[]): number {
  return entries.filter((entry) => entry.status === 'scanned').length
}
