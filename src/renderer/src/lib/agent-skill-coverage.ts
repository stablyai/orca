import type { DiscoveredSkill, SkillDiscoverySource } from '../../../shared/skills'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import {
  getNativeChatAgentProfile,
  readsSkillSource
} from '../../../shared/native-chat/native-chat-agent-profiles'

export function agentReadsSkill(
  agent: TuiAgent,
  skill: DiscoveredSkill,
  sources: readonly SkillDiscoverySource[]
): boolean {
  const owner = agent === 'claude-agent-teams' ? 'claude' : agent
  const reader = getNativeChatAgentProfile(agent) ?? { skillSourceOwner: owner }
  const rootPaths = skill.rootPaths?.length ? skill.rootPaths : [skill.rootPath]
  return rootPaths.some((rootPath) =>
    sources.some(
      (source) =>
        source.path === rootPath && source.sourceKind !== 'repo' && readsSkillSource(reader, source)
    )
  )
}
