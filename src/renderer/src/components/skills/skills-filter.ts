import type { DiscoveredSkill, SkillSourceKind } from '../../../../shared/skills'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import { skillMatchesAgent } from './skill-agent-filter'

export type SkillsFilterState = {
  query: string
  sourceKind: SkillSourceKind | 'all'
  /** Owning agent id, or 'all'. Resolved from the root a skill was found in. */
  agent: string
}

export const SKILLS_FILTER_QUERY_MAX_BYTES = 2 * 1024

export function isSkillsFilterQueryTooLarge(
  query: string,
  maxBytes = SKILLS_FILTER_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

export function filterSkills(
  skills: readonly DiscoveredSkill[],
  filters: SkillsFilterState,
  agentByRootPath: ReadonlyMap<string, string> = new Map()
): DiscoveredSkill[] {
  if (isSkillsFilterQueryTooLarge(filters.query)) {
    return []
  }
  const query = normalize(filters.query)
  return skills.filter((skill) => {
    if (filters.sourceKind !== 'all' && skill.sourceKind !== filters.sourceKind) {
      return false
    }
    if (!skillMatchesAgent(skill, filters.agent, agentByRootPath)) {
      return false
    }
    if (!query) {
      return true
    }
    const haystack = [
      skill.name,
      skill.description ?? '',
      skill.sourceLabel,
      skill.directoryPath,
      skill.providers.join(' ')
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(query)
  })
}

export function countSkillsBySource(
  skills: readonly DiscoveredSkill[]
): Record<SkillSourceKind, number> {
  return skills.reduce<Record<SkillSourceKind, number>>(
    (counts, skill) => {
      counts[skill.sourceKind] += 1
      return counts
    },
    { home: 0, repo: 0, bundled: 0, plugin: 0 }
  )
}
