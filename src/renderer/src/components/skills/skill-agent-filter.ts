import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../../shared/skills'
import { AI_VAULT_AGENT_LABELS } from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'

/** Roots like `.agents/skills` that every agent reads, so no single one owns them. */
export const SHARED_SKILL_AGENT = 'shared'

export type SkillAgentOption = { id: string; label: string; count: number }

export function skillAgentLabel(agentId: string): string {
  if (agentId === SHARED_SKILL_AGENT) {
    return translate('auto.components.skills.filter.sharedAgent', 'Shared (.agents)')
  }
  return (AI_VAULT_AGENT_LABELS as Record<string, string>)[agentId] ?? agentId
}

/**
 * Discovery tags every non-Codex, non-Claude root as `agent-skills` and keeps
 * the real agent on the source, so the owning agent has to come from the root
 * a skill was found in rather than from its provider list.
 */
export function skillAgentByRootPath(
  result: SkillDiscoveryResult | null
): ReadonlyMap<string, string> {
  return new Map(
    (result?.sources ?? []).map((source) => [source.path, source.owner ?? SHARED_SKILL_AGENT])
  )
}

function skillAgents(
  skill: DiscoveredSkill,
  agentByRootPath: ReadonlyMap<string, string>
): string[] {
  const roots = skill.rootPaths?.length ? skill.rootPaths : [skill.rootPath]
  return [...new Set(roots.map((root) => agentByRootPath.get(root)).filter(Boolean))] as string[]
}

export function skillMatchesAgent(
  skill: DiscoveredSkill,
  agentId: string,
  agentByRootPath: ReadonlyMap<string, string>
): boolean {
  return agentId === 'all' || skillAgents(skill, agentByRootPath).includes(agentId)
}

/** Only agents that actually hold a skill; an empty root is not a filter. */
export function skillAgentOptions(result: SkillDiscoveryResult | null): SkillAgentOption[] {
  const agentByRootPath = skillAgentByRootPath(result)
  const counts = new Map<string, number>()
  for (const skill of result?.skills ?? []) {
    for (const agent of skillAgents(skill, agentByRootPath)) {
      counts.set(agent, (counts.get(agent) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, label: skillAgentLabel(id), count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}
