import { quoteStartupArg, resolveStartupShell } from '../../../src/shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../src/shared/windows-terminal-shell'

/** Specs must apply this through `updateSettings`; the override below is quoted for it. */
export const FAKE_AGENT_WINDOWS_SHELL = 'powershell.exe'

export function buildFakeAgentCommandOverride(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
  terminalWindowsShell: string = FAKE_AGENT_WINDOWS_SHELL
): string {
  // Why resolve rather than assume PowerShell on win32: the startup shell comes
  // from the user's terminalWindowsShell setting, and a cmd/Git Bash/WSL host
  // would silently fail to launch a PowerShell-quoted path.
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({ platform, isRemote: false, terminalWindowsShell })
  )
  const quotedPath = quoteStartupArg(executablePath, shell)
  return shell === 'powershell' ? `& ${quotedPath}` : quotedPath
}
