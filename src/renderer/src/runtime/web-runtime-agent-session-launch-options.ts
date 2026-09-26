import {
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT,
  getSystemPrefersDark,
  getTerminalThemePreview
} from '@/lib/terminal-theme'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../shared/tui-agent'
import { resolveMobileTerminalTheme } from './sync-runtime-graph/mobile-terminal-theme'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import type { CreateWebRuntimeSessionTerminalArgs } from './web-runtime-session-types'

export function webRuntimeAgentSessionLaunchOptions(
  args: CreateWebRuntimeSessionTerminalArgs,
  agent: TuiAgent
) {
  // Why: the host starts the agent before its viewer can answer OSC 10/11.
  const systemPrefersDark = getSystemPrefersDark()
  const theme =
    resolveMobileTerminalTheme(useAppStore.getState(), systemPrefersDark)?.theme ??
    getTerminalThemePreview(
      systemPrefersDark ? DEFAULT_TERMINAL_THEME_DARK : DEFAULT_TERMINAL_THEME_LIGHT
    )
  const foreground = theme?.foreground
  const background = theme?.background
  const agentArgs = args.agentArgs !== undefined ? args.agentArgs : args.launchConfig?.agentArgs
  return {
    launchOptions: {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      agent,
      ...(agentArgs !== undefined ? { agentArgs } : {}),
      ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {})
    },
    terminalColors: foreground && background ? { foreground, background } : undefined
  }
}
