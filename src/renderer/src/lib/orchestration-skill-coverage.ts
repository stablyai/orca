import type { AgentType } from '../../../shared/agent-status-types'
import type { DiscoveredSkill, SkillDiscoverySource } from '../../../shared/skills'
import type { TuiAgent } from '../../../shared/tui-agent'
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

// Why: `native-chat-agent-profiles.ts` carries the same rule as `skillSourceOwner`;
// keep the two in step when an agent starts reading another agent's roots.
function getSkillSourceOwnerForAgent(agent: TuiAgent): AgentType {
  // Why: both launch Claude Code and therefore consume Claude-owned skill roots.
  return agent === 'claude-agent-teams' || agent === 'openclaude' ? 'claude' : agent
}

/** `skills` and `sources` must come from the same discovery scan. */
export function agentHasOrchestrationSkill(
  agent: TuiAgent,
  skills: readonly DiscoveredSkill[],
  sources: readonly SkillDiscoverySource[]
): boolean {
  const owner = getSkillSourceOwnerForAgent(agent)
  return skills.some((skill) => {
    if (!isOrchestrationSkill(skill)) {
      return false
    }
    // Why: dedup keeps one row, so the roots it absorbed still have to be classified.
    const rootPaths = skill.rootPaths?.length ? skill.rootPaths : [skill.rootPath]
    return rootPaths.some((rootPath) =>
      // Why: one path can carry several sources — a workspace whose cwd is the
      // home dir scans `~/.claude/skills` as both a home and a repo root. Keying
      // by path would let the repo duplicate shadow the owning home root.
      sources.some(
        (source) =>
          source.path === rootPath &&
          source.sourceKind !== 'repo' &&
          (source.owner === null || source.owner === owner)
      )
    )
  })
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
