import { quoteStartupArg, resolveStartupShell } from '../../../src/shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../src/shared/windows-terminal-shell'

/** Specs must apply this through `updateSettings`; the override below is quoted for it. */
export const FAKE_AGENT_WINDOWS_SHELL = 'powershell.exe'

export function buildFakeAgentCommandOverride(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
  terminalWindowsShell: string = FAKE_AGENT_WINDOWS_SHELL
): string {
  // Quote for the configured Windows startup shell; PowerShell quoting fails when the user selects cmd/Git Bash/WSL.
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({ platform, isRemote: false, terminalWindowsShell })
  )
  const quotedPath = quoteStartupArg(executablePath, shell)
  return shell === 'powershell' ? `& ${quotedPath}` : quotedPath
}
