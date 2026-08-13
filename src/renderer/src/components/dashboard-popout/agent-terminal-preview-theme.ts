import type { ITheme, Terminal } from '@xterm/xterm'
import {
  composeActiveTerminalTheme,
  composedTerminalThemesEqual
} from '../../../../shared/compose-active-terminal-theme'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'

export function resolvePreviewAgent(agentType?: string | null): TuiAgent | null {
  return isTuiAgent(agentType) ? agentType : null
}

export function resolveAgentPreviewTheme(
  settings: GlobalSettings | null | undefined,
  systemPrefersDark: boolean,
  agent?: TuiAgent | null
): { terminalTheme: ITheme | null; terminalMode: 'dark' | 'light' } {
  if (!settings) {
    return { terminalTheme: null, terminalMode: 'dark' }
  }
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark, agent)
  return {
    terminalTheme: composeActiveTerminalTheme(
      appearance.theme ?? getBuiltinTheme(appearance.themeName),
      settings
    ),
    terminalMode: appearance.mode
  }
}

/** Why value-gated: writing options.theme rebuilds the palette; skip when unchanged. */
export function applyAgentPreviewThemeIfChanged(
  terminal: Pick<Terminal, 'options'>,
  theme: ITheme | null
): void {
  if (theme && !composedTerminalThemesEqual(terminal.options.theme, theme)) {
    terminal.options.theme = theme
  }
}
