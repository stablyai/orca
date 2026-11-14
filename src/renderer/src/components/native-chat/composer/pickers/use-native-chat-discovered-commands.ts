import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { DiscoveredSlashCommand } from '../../../../../../shared/custom-slash-commands'
import {
  mergeDiscoveredSlashCommands,
  type SlashCommandSuggestion
} from '../../../../../../shared/native-chat/input/native-chat-slash-commands'

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
