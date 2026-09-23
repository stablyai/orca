import { getSystemPrefersDark } from '@/lib/terminal-theme'
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
  const theme = resolveMobileTerminalTheme(useAppStore.getState(), getSystemPrefersDark())?.theme
  const agentArgs = args.agentArgs !== undefined ? args.agentArgs : args.launchConfig?.agentArgs
  return {
    worktree: toRuntimeWorktreeSelector(args.worktreeId),
    agent,
    ...(theme
      ? {
          terminalColorQueryReplies: { foreground: theme.foreground, background: theme.background }
        }
      : {}),
    ...(agentArgs !== undefined ? { agentArgs } : {}),
    ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {})
  }
}
