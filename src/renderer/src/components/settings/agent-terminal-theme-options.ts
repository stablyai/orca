import { translate } from '@/i18n/i18n'
import { getAvailableTerminalThemeOptions, type TerminalThemeOption } from '@/lib/terminal-theme'
import { AGENT_TERMINAL_THEME_INHERIT } from '../../../../shared/agent-terminal-themes'
import type { GlobalSettings } from '../../../../shared/types'

export function getAgentTerminalThemeOptions(
  settings: Pick<GlobalSettings, 'terminalCustomThemes'>
): TerminalThemeOption[] {
  const inheritOption: TerminalThemeOption = {
    value: AGENT_TERMINAL_THEME_INHERIT,
    label: translate(
      'auto.components.settings.AgentTerminalThemes.inherit_global',
      'Inherit global'
    ),
    group: 'inherit',
    previewTheme: null
  }
  return [inheritOption, ...getAvailableTerminalThemeOptions(settings)]
}

export function getAgentTerminalThemeSelectionLabel(
  options: readonly TerminalThemeOption[],
  selection: string
): string {
  return options.find((option) => option.value === selection)?.label ?? selection
}
