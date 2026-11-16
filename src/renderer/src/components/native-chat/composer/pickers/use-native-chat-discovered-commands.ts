import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { DiscoveredSlashCommand } from '../../../../../../shared/skills/discovery/custom-slash-commands'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import {
  mergeDiscoveredSlashCommands,
  type NativeChatSessionSkill,
  type SlashCommandSuggestion
} from '../../../../../../shared/native-chat/input/commands/native-chat-slash-commands'
import { nativeChatPickerCommands } from '../../../../../../shared/native-chat/input/commands/native-chat-skill-visibility'
import { useNativeChatSkills } from './use-native-chat-skills'

const NO_COMMANDS: readonly DiscoveredSlashCommand[] = []

/** Curated commands plus disk-discovered `.claude/commands`, for the picker and for send classification. */
export function useNativeChatDiscoveredCommands(
  agentCommands: readonly SlashCommandSuggestion[],
  /** Undefined when the session reports its own commands, which already include `.claude/commands`. */
  discovered: readonly DiscoveredSlashCommand[] | undefined,
  scope: string
): {
  commands: readonly SlashCommandSuggestion[]
  sendCommands: () => readonly SlashCommandSuggestion[]
} {
  const current = discovered ?? NO_COMMANDS
  const commands = useMemo(
    () => mergeDiscoveredSlashCommands(agentCommands, current),
    [agentCommands, current]
  )
  // Discovery idles once arguments close the `/` token, so sends keep the last catalog,
  // tagged with its pane so a tab switch cannot classify the previous tab's commands.
  const retainedRef = useRef<{ scope: string; commands: readonly DiscoveredSlashCommand[] } | null>(
    null
  )
  useEffect(() => {
    if (current.length > 0) {
      retainedRef.current = { scope, commands: current }
    }
  }, [current, scope])
  const sendCommands = useCallback(() => {
    const retained = retainedRef.current
    return discovered && retained?.scope === scope
      ? mergeDiscoveredSlashCommands(agentCommands, retained.commands)
      : commands
  }, [agentCommands, commands, discovered, scope])
  return { commands, sendCommands }
}

/** Skill discovery plus the picker and send command lists built from it. */
export function useNativeChatPickerCommands(args: {
  agent: AgentType
  agentCommands: readonly SlashCommandSuggestion[]
  sessionSkills: readonly NativeChatSessionSkill[] | undefined
  terminalTabId: string
  launchWorktreeId: string | undefined
  skillPickerTriggered: boolean
}): {
  discovery: ReturnType<typeof useNativeChatSkills>
  pickerCommands: readonly SlashCommandSuggestion[]
  sendCommands: () => readonly SlashCommandSuggestion[]
} {
  const { agent, terminalTabId, launchWorktreeId } = args
  const discovery = useNativeChatSkills(
    agent,
    terminalTabId,
    args.skillPickerTriggered,
    launchWorktreeId
  )
  const { commands, sendCommands } = useNativeChatDiscoveredCommands(
    args.agentCommands,
    args.sessionSkills === undefined ? discovery.commands : undefined,
    `${terminalTabId}\0${launchWorktreeId ?? ''}\0${agent}`
  )
  const pickerCommands = useMemo(
    () => nativeChatPickerCommands(agent, commands, discovery.skills),
    [agent, commands, discovery.skills]
  )
  return { discovery, pickerCommands, sendCommands }
}
