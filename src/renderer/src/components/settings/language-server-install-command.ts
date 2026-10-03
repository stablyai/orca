import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import { resolveWindowsShellStartupFamily } from '../../../../shared/windows-terminal-shell'
import { quotePosixShell } from '../../../../shared/wsl-login-shell-command'
import { quotePowerShellLiteral } from '../../../../shared/powershell-native-argument'
import { isWslShellName } from '../../../../shared/local-windows-terminal-runtime'

export type InstallShellFamily = AgentStartupShell

export function installShellFamily(
  effectiveShell: string | undefined,
  isWindows: boolean
): InstallShellFamily {
  if (isWindows) {
    return resolveWindowsShellStartupFamily(effectiveShell)
  }
  return 'posix'
}

export function buildLanguageServerInstallCommand(
  command: string,
  projectPath: string,
  family: InstallShellFamily,
  effectiveShell?: string
): string {
  if (isWslShellName(effectiveShell)) {
    return command
  }

  switch (family) {
    case 'powershell':
      return `Set-Location -LiteralPath ${quotePowerShellLiteral(projectPath)}; ${command}`
    case 'cmd':
      // Why: cmd expands %VAR% even inside double quotes. A path like
      // C:\Users\%TEMP% would redirect to the temp dir. pushd handles this
      // and also supports UNC paths that cd /d rejects.
      if (projectPath.includes('%')) {
        return command
      }
      return `pushd "${projectPath}" && ${command}`
    case 'posix':
      return `cd -- ${quotePosixShell(projectPath)} && ${command}`
  }
}
