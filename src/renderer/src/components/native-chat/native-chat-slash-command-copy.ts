import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import type { SlashCommandSuggestion } from '../../../../shared/native-chat-slash-commands'
import type { AgentType } from '../../../../shared/agent-status-types'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

// Why: claude/openclaude and codex curate distinct English text for the same
// command name (e.g. "clear"), so the i18n key is namespaced per catalog
// family — keying on name alone would force unrelated descriptions to share
// one translation.
type SlashCommandFamily = 'common' | 'claude' | 'codex'

function slashCommandFamily(agent: AgentType): SlashCommandFamily {
  if (agent === 'claude' || agent === 'openclaude') {
    return 'claude'
  }
  return agent === 'codex' ? 'codex' : 'common'
}

function localizeSlashCommand(
  family: SlashCommandFamily,
  command: SlashCommandSuggestion
): SlashCommandSuggestion {
  if (!command.description) {
    return command
  }
  return {
    ...command,
    description: translate(
      `nativeChatSlashCommands.${family}.${command.name}.description`,
      command.description
    )
  }
}

const catalogsByFamily = new Map<SlashCommandFamily, () => readonly SlashCommandSuggestion[]>()

/** Localizes only `description` (display copy); `name` is the literal dispatch
 *  token and must stay verbatim. Grok's always-empty catalog short-circuits
 *  before touching the per-family cache, since it isn't backed by a stable
 *  family of curated commands. */
export function getLocalizedNativeChatSlashCommands(
  agent: AgentType
): readonly SlashCommandSuggestion[] {
  const commands = getVerifiedNativeChatCommands(agent)
  if (commands.length === 0) {
    return commands
  }
  const family = slashCommandFamily(agent)
  let catalog = catalogsByFamily.get(family)
  if (!catalog) {
    catalog = createLocalizedCatalog(() =>
      commands.map((command) => localizeSlashCommand(family, command))
    )
    catalogsByFamily.set(family, catalog)
  }
  return catalog()
}
