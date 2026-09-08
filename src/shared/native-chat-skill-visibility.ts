// Which discovered skills a native-chat surface should offer for an agent.
// Pure over shared types so the desktop renderer and the mobile app share one
// visibility rule instead of drifting.

import type { AgentType } from './agent-status-types'
import { getNativeChatAgentProfile } from './native-chat-agent-profiles'
import type { DiscoveredSkill, SkillDiscoveryResult } from './skills'

export function isNativeChatSkillForAgent(
  agent: AgentType,
  skill: DiscoveredSkill,
  result?: Pick<SkillDiscoveryResult, 'sources'>
): boolean {
  const profile = getNativeChatAgentProfile(agent)
  if (!profile) {
    return false
  }
  if (!result) {
    return (
      agent === 'codex' &&
      (skill.providers.includes('codex') || skill.providers.includes('agent-skills'))
    )
  }
  // Why: canonical-path dedup keeps one row per file, but a symlinked skill can
  // be reachable through several roots; any shared or agent-owned root grants
  // visibility regardless of which root the scanner happened to list first.
  const rootPaths = skill.rootPaths?.length ? skill.rootPaths : [skill.rootPath]
  return rootPaths.some((rootPath) => {
    const source = result.sources.find((entry) => entry.path === rootPath)
    return source?.owner === null || source?.owner === profile.skillSourceOwner
  })
}
