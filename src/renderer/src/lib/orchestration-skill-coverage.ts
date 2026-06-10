import type { DiscoveredSkill } from '../../../shared/skills'
import type { TuiAgent } from '../../../shared/types'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import { getAgentLabel } from '@/lib/agent-catalog'
import { TUI_AGENT_AUTO_PICK_ORDER } from '../../../shared/tui-agent-selection'

export type OrchestrationSkillLocationId =
  | 'claude-home'
  | 'codex-home'
  | 'codex-plugin-cache'
  | 'agents-home'

export type OrchestrationSkillAgentStatus = {
  agent: TuiAgent
  label: string
  installed: boolean
}

type OrchestrationSkillLocationDefinition = {
  id: OrchestrationSkillLocationId
  matchesSkill: (skill: DiscoveredSkill) => boolean
}

const ORCHESTRATION_SKILL_LOCATIONS: readonly OrchestrationSkillLocationDefinition[] = [
  {
    id: 'claude-home',
    matchesSkill: (skill) =>
      isGlobalOrchestrationSkill(skill) &&
      pathContainsSegments(skill.rootPath, ['.claude', 'skills'])
  },
  {
    id: 'codex-home',
    matchesSkill: (skill) =>
      isGlobalOrchestrationSkill(skill) &&
      pathContainsSegments(skill.rootPath, ['.codex', 'skills'])
  },
  {
    id: 'codex-plugin-cache',
    matchesSkill: (skill) =>
      isGlobalOrchestrationSkill(skill) &&
      pathContainsSegments(skill.rootPath, ['.codex', 'plugins', 'cache'])
  },
  {
    id: 'agents-home',
    matchesSkill: (skill) =>
      isGlobalOrchestrationSkill(skill) &&
      pathContainsSegments(skill.rootPath, ['.agents', 'skills'])
  }
]

const ORCHESTRATION_SKILL_LOCATION_IDS_BY_AGENT: Partial<
  Record<TuiAgent, readonly OrchestrationSkillLocationId[]>
> = {
  claude: ['claude-home', 'agents-home'],
  openclaude: ['claude-home', 'agents-home'],
  codex: ['codex-home', 'codex-plugin-cache', 'agents-home']
}

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase()
}

function basenameFromPath(pathValue: string): string {
  return pathValue.split(/[\\/]/).filter(Boolean).at(-1) ?? pathValue
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').toLowerCase()
}

function pathContainsSegments(pathValue: string, segments: readonly string[]): boolean {
  const parts = normalizePath(pathValue).split('/').filter(Boolean)
  const target = segments.map((segment) => segment.toLowerCase())
  if (target.length === 0 || parts.length < target.length) {
    return false
  }
  for (let index = 0; index <= parts.length - target.length; index += 1) {
    if (target.every((segment, offset) => parts[index + offset] === segment)) {
      return true
    }
  }
  return false
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

function isGlobalOrchestrationSkill(skill: DiscoveredSkill): boolean {
  return isOrchestrationSkill(skill) && skill.sourceKind !== 'repo'
}

function getOrchestrationSkillLocationIdsForAgent(
  agent: TuiAgent
): readonly OrchestrationSkillLocationId[] {
  return ORCHESTRATION_SKILL_LOCATION_IDS_BY_AGENT[agent] ?? ['agents-home']
}

function isOrchestrationSkillInstalledAtLocation(
  skills: readonly DiscoveredSkill[],
  locationId: OrchestrationSkillLocationId
): boolean {
  const location = ORCHESTRATION_SKILL_LOCATIONS.find((entry) => entry.id === locationId)
  if (!location) {
    return false
  }
  return skills.some((skill) => location.matchesSkill(skill))
}

export function agentHasOrchestrationSkill(
  agent: TuiAgent,
  skills: readonly DiscoveredSkill[]
): boolean {
  return getOrchestrationSkillLocationIdsForAgent(agent).some((locationId) =>
    isOrchestrationSkillInstalledAtLocation(skills, locationId)
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
  detectedAgents: readonly TuiAgent[]
): OrchestrationSkillAgentStatus[] {
  return sortOrchestrationAgents(detectedAgents).map((agent) => ({
    agent,
    label: getAgentLabel(agent),
    installed: agentHasOrchestrationSkill(agent, skills)
  }))
}
