import type { AgentType } from './agent-status-types'
import type { AgentSessionSlashCommand } from './agent-session-wire'
import type { DiscoveredSkill, SkillDiscoveryResult } from './skills'
import { getNativeChatAgentProfile, readsSkillSource } from './native-chat-agent-profiles'
import { classifyPickerCommands } from './native-chat/input/native-chat-picker-items'
import {
  sessionReportedSkills,
  type NativeChatSessionSkill,
  type SlashCommandSuggestion
} from './native-chat/input/native-chat-slash-commands'
import { isStructuredAgentSessionComposerCommand } from './structured-agent-session-composer'

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
  // Canonical dedup may hide alternate symlink roots; any shared/agent root grants visibility regardless of scan order.
  const rootPaths = skill.rootPaths?.length ? skill.rootPaths : [skill.rootPath]
  return rootPaths.some((rootPath) => {
    const source = result.sources.find((entry) => entry.path === rootPath)
    return source !== undefined && readsSkillSource(profile, source)
  })
}

/** Skills the session reported; undefined keeps the host disk scan (also for chats that keep scanned skills). */
export function nativeChatSessionSkills(
  agent: AgentType,
  reported: readonly AgentSessionSlashCommand[] | undefined
): readonly NativeChatSessionSkill[] | undefined {
  const keepsScannedSkills = getNativeChatAgentProfile(agent)?.keepsScannedSkills === true
  return reported !== undefined && !keepsScannedSkills ? sessionReportedSkills(reported) : undefined
}

export function nativeChatPickerCommands(
  agent: AgentType,
  commands: readonly SlashCommandSuggestion[],
  scannedSkills: readonly DiscoveredSkill[]
): readonly SlashCommandSuggestion[] {
  return classifyPickerCommands(commands, scannedSkills, {
    // A chat that keeps scanned skills (OpenCode) may report each as a command too.
    reportMayListSkills: getNativeChatAgentProfile(agent)?.keepsScannedSkills === true,
    isSendCommand: (name) => isStructuredAgentSessionComposerCommand(`/${name}`, agent)
  })
}
