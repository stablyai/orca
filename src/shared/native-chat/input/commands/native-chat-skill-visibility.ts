import type { AgentType } from '../../../agent-status/contracts/agent-status-types'
import type { AgentSessionSlashCommand } from '../../../agent-session/agent-session-wire'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../skills/discovery/skills'
import { getNativeChatAgentProfile, readsSkillSource } from './native-chat-agent-profiles'
import { classifyPickerCommands } from '../composer/native-chat-picker-items'
import {
  sessionReportedSkills,
  type NativeChatSessionSkill,
  type SlashCommandSuggestion
} from './native-chat-slash-commands'
import { isStructuredAgentSessionComposerCommand } from '../../../agent-session/view/structured-agent-session-composer'

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
  // Canonical dedup may hide alternate symlink roots, and two sources can share a path (a project
  // in the home folder); any one that grants visibility counts, regardless of scan order.
  const rootPaths = skill.rootPaths?.length ? skill.rootPaths : [skill.rootPath]
  return rootPaths.some((rootPath) =>
    result.sources.some(
      (entry) => entry.path === rootPath && readsSkillSource(profile, entry, skill)
    )
  )
}

/** Skills the session reported; undefined keeps the host disk scan (also for chats that keep scanned skills). */
export function nativeChatSessionSkills(
  agent: AgentType,
  reported: readonly AgentSessionSlashCommand[] | undefined
): readonly NativeChatSessionSkill[] | undefined {
  const keepsScannedSkills = getNativeChatAgentProfile(agent)?.keepsScannedSkills === true
  return reported !== undefined && !keepsScannedSkills
    ? sessionReportedSkills(reported, agent)
    : undefined
}

export function nativeChatPickerCommands(
  agent: AgentType,
  commands: readonly SlashCommandSuggestion[],
  scannedSkills: readonly DiscoveredSkill[]
): readonly SlashCommandSuggestion[] {
  return classifyPickerCommands(commands, scannedSkills, {
    // A chat that keeps scanned skills (OpenCode) may report each as a command too.
    reportMayListSkills: getNativeChatAgentProfile(agent)?.keepsScannedSkills === true,
    isSendCommand: (name) => isStructuredAgentSessionComposerCommand(`/${name}`, agent, [])
  })
}
