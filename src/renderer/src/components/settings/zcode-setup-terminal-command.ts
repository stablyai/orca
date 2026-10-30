import type { ZcodeSetupInvocation } from '../../../../preload/api/preflight-api'
import {
  buildShellCommandFromArgv,
  commandSeparator,
  quoteStartupArg,
  resolveStartupShell,
  type AgentStartupShell
} from '../../../../shared/tui-agent-startup-shell'
import { resolveWindowsShellStartupFamily } from '../../../../shared/windows-terminal-shell'

function shellFamily(effectiveShell: string | undefined): AgentStartupShell {
  return effectiveShell
    ? resolveWindowsShellStartupFamily(effectiveShell)
    : resolveStartupShell(navigator.userAgent.includes('Windows') ? 'win32' : 'linux')
}

function envPrefix(env: Record<string, string>, shell: AgentStartupShell): string {
  const entries = Object.entries(env)
  if (entries.length === 0) {
    return ''
  }
  if (shell === 'powershell') {
    return `${entries
      .map(([name, value]) => `$env:${name} = ${quoteStartupArg(value, shell)}`)
      .join(commandSeparator(shell))}${commandSeparator(shell)}`
  }
  if (shell === 'cmd') {
    return `${entries
      .map(([name, value]) => `set ${quoteStartupArg(`${name}=${value}`, shell)}`)
      .join(commandSeparator(shell))}${commandSeparator(shell)}`
  }
  return `${entries.map(([name, value]) => `${name}=${quoteStartupArg(value, shell)}`).join(' ')} `
}

export function buildZcodeSetupTerminalCommand(
  invocation: ZcodeSetupInvocation,
  effectiveShell: string | undefined
): string {
  const shell = shellFamily(effectiveShell)
  return `${envPrefix(invocation.env, shell)}${buildShellCommandFromArgv(
    [invocation.command, ...invocation.args],
    shell
  )}`
}
