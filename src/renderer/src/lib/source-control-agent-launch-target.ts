import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import type { AgentLaunchTarget } from '../../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'

/** Where a Source Control action's agent launches, as its plan quotes the command for it. */
export function resolveSourceControlAgentLaunchTarget(args: {
  platform?: NodeJS.Platform
  isRemote?: boolean
  terminalWindowsShell?: string | null
}): AgentLaunchTarget {
  const platform = args.platform ?? CLIENT_PLATFORM
  return {
    platform,
    shell: resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: args.isRemote ?? false,
      terminalWindowsShell: args.terminalWindowsShell
    })
  }
}
