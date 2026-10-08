// The one line under an agent's Arguments field that says where they apply. Only agents with the
// updated native chat have one: that chat ignores saved Arguments, while terminal tabs and the
// terminal-backed chat still launch with them.
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../../shared/tui-agent'

const ARGUMENTS_DESCRIPTIONS: Partial<Record<TuiAgent, () => string>> = {
  claude: () =>
    translate(
      'auto.components.settings.AgentsPane.argumentsUse.claude',
      "Used in terminal tabs and terminal chats. The updated native chat doesn't use these; put its settings in ~/.claude/settings.json."
    ),
  codex: () =>
    translate(
      'auto.components.settings.AgentsPane.argumentsUse.codex',
      "Used in terminal tabs and terminal chats. The updated native chat doesn't use these; put its settings in ~/.codex/config.toml."
    ),
  grok: () =>
    translate(
      'auto.components.settings.AgentsPane.argumentsUse.grok',
      "Used in terminal tabs and terminal chats. The updated native chat doesn't use these; put its settings in ~/.grok/config.toml."
    ),
  opencode: () =>
    translate(
      'auto.components.settings.AgentsPane.argumentsUse.opencode',
      "Used in terminal tabs and terminal chats. The updated native chat doesn't use these; put its settings in ~/.config/opencode/opencode.json."
    ),
  omp: () =>
    translate(
      'auto.components.settings.AgentsPane.argumentsUse.omp',
      "Used in terminal tabs and terminal chats. The updated native chat doesn't use these."
    )
}

export function agentArgumentsDescription(agent: TuiAgent): string | undefined {
  return ARGUMENTS_DESCRIPTIONS[agent]?.()
}
