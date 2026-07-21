import type { AgentType } from '../../../shared/agent-status-types'
import type { DiscoveredSkill, SkillDiscoverySource } from '../../../shared/skills'
import type { TuiAgent } from '../../../shared/types'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import { getAgentLabel } from '@/lib/agent-catalog'
import { TUI_AGENT_AUTO_PICK_ORDER } from '../../../shared/tui-agent-selection'

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

function getSkillSourceOwnerForAgent(agent: TuiAgent): AgentType {
  // Why: both launch Claude Code and therefore consume Claude-owned skill roots.
  return agent === 'claude-agent-teams' || agent === 'openclaude' ? 'claude' : agent
}

function agentHasOrchestrationSkillFromSources(
  agent: TuiAgent,
  skills: readonly DiscoveredSkill[],
  sourcesByPath: ReadonlyMap<string, SkillDiscoverySource>
): boolean {
  const owner = getSkillSourceOwnerForAgent(agent)
  return skills.some((skill) => {
    if (!isOrchestrationSkill(skill)) {
      return false
    }
    // Why: symlink dedup can merge global and repo installs; each source retains
    // the ownership and scope needed to classify every contributing root.
    const rootPaths = skill.rootPaths?.length ? skill.rootPaths : [skill.rootPath]
    return rootPaths.some((rootPath) => {
      const source = sourcesByPath.get(rootPath)
      return Boolean(
        source && source.sourceKind !== 'repo' && (source.owner === null || source.owner === owner)
      )
    })
  })
}

function indexSkillSources(
  sources: readonly SkillDiscoverySource[]
): ReadonlyMap<string, SkillDiscoverySource> {
  return new Map(sources.map((source) => [source.path, source]))
}

export function agentHasOrchestrationSkill(
  agent: TuiAgent,
  skills: readonly DiscoveredSkill[],
  sources: readonly SkillDiscoverySource[]
): boolean {
  return agentHasOrchestrationSkillFromSources(agent, skills, indexSkillSources(sources))
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
  const sourcesByPath = indexSkillSources(sources)
  return sortOrchestrationAgents(detectedAgents).map((agent) => ({
    agent,
    label: getAgentLabel(agent),
    installed: agentHasOrchestrationSkillFromSources(agent, skills, sourcesByPath)
  }))
}
