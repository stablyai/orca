import type { AgentStartupShell } from './tui-agent-startup-shell'
import type { WorktreeStartupLaunch } from './worktree/launch-types'

export const AUTOMATION_SHELL_COMMAND_ENV = 'ORCA_AUTOMATION_COMMAND'

export function buildAutomationShellStartup(
  command: string,
  shell: AgentStartupShell
): WorktreeStartupLaunch {
  // Exit the PTY when the command finishes; no agent will emit a completion hook.
  const launchCommand =
    shell === 'posix'
      ? `exec "$SHELL" -c "$${AUTOMATION_SHELL_COMMAND_ENV}"`
      : shell === 'cmd'
        ? `cmd.exe /d /s /c "%${AUTOMATION_SHELL_COMMAND_ENV}%" & exit`
        : [
            `$orcaCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($env:${AUTOMATION_SHELL_COMMAND_ENV}));`,
            '& (Get-Process -Id $PID).Path -NoLogo -NoProfile -NonInteractive -EncodedCommand $orcaCommand;',
            'exit $LASTEXITCODE'
          ].join(' ')
  return {
    command: launchCommand,
    env: { [AUTOMATION_SHELL_COMMAND_ENV]: command },
    startupCommandDelivery: 'shell-ready'
  }
}
