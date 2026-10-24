// Which discovered skills a native-chat surface should offer for an agent, and
// the name each row invokes. Pure over shared types so the desktop picker and
// the mobile menu share one rule instead of drifting.

import type { AgentType } from './agent-status-types'
import { getNativeChatAgentProfile, readsSkillSource } from './native-chat-agent-profiles'
import type { DiscoveredSkill, SkillDiscoveryResult } from './skills'

const CLAUDE_PLUGIN_LABEL_PREFIX = 'Claude plugin '

/** The plugin a discovered plugin-skill belongs to, or null. Prefers the
 *  structured plugin field; the label parse stays as the older-host fallback. */
export function discoveredSkillPlugin(skill: DiscoveredSkill): string | null {
  if (skill.sourceKind !== 'plugin') {
    return null
  }
  return skill.plugin ?? parsePluginLabel(skill.sourceLabel)
}

/** The name the composer inserts for a discovered skill. Plugin skills are
 *  namespaced (`quiver:catchup`) the way the agent itself addresses them, so
 *  a plugin skill and a same-named home skill stay distinct rows. */
export function discoveredSkillTokenName(skill: DiscoveredSkill): string {
  return pluginNamespacedSkillName(skill, skill.name)
}

/** `name` namespaced for invocation when the skill belongs to a plugin. */
export function pluginNamespacedSkillName(skill: DiscoveredSkill, name: string): string {
  const plugin = discoveredSkillPlugin(skill)
  return plugin ? `${plugin}:${name}` : name
}

function parsePluginLabel(sourceLabel: string): string | null {
  if (!sourceLabel.startsWith(CLAUDE_PLUGIN_LABEL_PREFIX)) {
    return null
  }
  return sourceLabel.slice(CLAUDE_PLUGIN_LABEL_PREFIX.length) || null
}

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
    return source !== undefined && readsSkillSource(profile, source)
  })
}
