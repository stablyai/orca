import type { DiscoveredSkill, SkillDiscoverySource } from '../../../shared/skills'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { agentReadsSkill } from './agent-skill-coverage'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-skill-names'
import { getAgentLabel } from '@/lib/agent-catalog'
import { TUI_AGENT_AUTO_PICK_ORDER } from '../../../shared/agent-launch/catalog/tui-agent-selection'

export type OrchestrationSkillAgentStatus = {
  agent: TuiAgent
  label: string
  installed: boolean
}

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase()
}

function basenameFromPath(pathValue: string): string {
  return pathValue.split(/[\\/]/).findLast(Boolean) ?? pathValue
}

function isOrchestrationSkill(skill: DiscoveredSkill): boolean {
  if (!skill.installed) {
    return false
  }
  const expected = normalizeSkillName(ORCHESTRATION_SKILL_NAME)
  return (
    normalizeSkillName(skill.name) === expected ||
    normalizeSkillName(basenameFromPath(skill.directoryPath)) === expected
  )
}

/** `skills` and `sources` must come from the same discovery scan. */
export function agentHasOrchestrationSkill(
  agent: TuiAgent,
  skills: readonly DiscoveredSkill[],
  sources: readonly SkillDiscoverySource[]
): boolean {
  return skills.some(
    (skill) => isOrchestrationSkill(skill) && agentReadsSkill(agent, skill, sources)
  )
}

export function sortOrchestrationAgents(agents: readonly TuiAgent[]): TuiAgent[] {
  const order = new Map<TuiAgent, number>()
  for (const [index, agent] of TUI_AGENT_AUTO_PICK_ORDER.entries()) {
    order.set(agent, index)
  }
  return [...agents].sort(
    (left, right) =>
      (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER)
  )
}

export function getOrchestrationSkillAgentStatuses(
  skills: readonly DiscoveredSkill[],
  detectedAgents: readonly TuiAgent[],
  sources: readonly SkillDiscoverySource[]
): OrchestrationSkillAgentStatus[] {
  return sortOrchestrationAgents(detectedAgents).map((agent) => ({
    agent,
    label: getAgentLabel(agent),
    installed: agentHasOrchestrationSkill(agent, skills, sources)
  }))
}
