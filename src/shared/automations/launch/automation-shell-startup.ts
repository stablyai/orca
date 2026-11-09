import type { AgentStartupShell } from '../../agent-launch/startup/tui-agent-startup-shell'
import type { WorktreeStartupLaunch } from '../../worktree/launch-types'

export const AUTOMATION_SHELL_COMMAND_ENV = 'ORCA_AUTOMATION_COMMAND'

export function buildAutomationShellStartup(
  command: string,
  shell: AgentStartupShell,
  runId?: string
): WorktreeStartupLaunch {
  if (runId) {
    return buildTrackedShellStartup(command, shell, runId)
  }
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

function buildTrackedShellStartup(
  command: string,
  shell: AgentStartupShell,
  runId: string
): WorktreeStartupLaunch {
  const launchCommand =
    shell === 'posix'
      ? `exec /bin/sh -c '"$SHELL" -c "$ORCA_AUTOMATION_COMMAND"; orca_status=$?; printf "%s%s%s" "$ORCA_AUTOMATION_RECEIPT_PREFIX" "$orca_status" "$ORCA_AUTOMATION_RECEIPT_SUFFIX"; exit "$orca_status"'`
      : shell === 'cmd'
        ? 'cmd.exe /d /v:on /s /c "%ORCA_AUTOMATION_SUPERVISOR%" & exit'
        : [
            `& (Get-Process -Id $PID).Path -NoLogo -NoProfile -NonInteractive -Command '& ([scriptblock]::Create($env:ORCA_AUTOMATION_COMMAND + [Environment]::NewLine + ''exit ([int](-not $?))''))';`,
            '$orcaStatus = $LASTEXITCODE;',
            '[Console]::Write($env:ORCA_AUTOMATION_RECEIPT_PREFIX + $orcaStatus + $env:ORCA_AUTOMATION_RECEIPT_SUFFIX);',
            'exit $orcaStatus'
          ].join(' ')
  return {
    command: launchCommand,
    env: {
      [AUTOMATION_SHELL_COMMAND_ENV]: command,
      ORCA_AUTOMATION_RECEIPT_PREFIX: '\x1b]133;D;',
      ORCA_AUTOMATION_RECEIPT_SUFFIX: `;orca-automation:${runId}\x07`,
      ...(shell === 'cmd'
        ? {
            ORCA_AUTOMATION_BANG: '!',
            // Defer bangs until the child parses the script, even if the parent enables delayed expansion.
            ORCA_AUTOMATION_SUPERVISOR: [
              'cmd.exe /d /v:off /s /c "!ORCA_AUTOMATION_COMMAND!"',
              'set "ORCA_AUTOMATION_EXIT_CODE=!errorlevel!"',
              'echo !ORCA_AUTOMATION_RECEIPT_PREFIX!!ORCA_AUTOMATION_EXIT_CODE!!ORCA_AUTOMATION_RECEIPT_SUFFIX!',
              'exit !ORCA_AUTOMATION_EXIT_CODE!'
            ]
              .join(' & ')
              .replaceAll('!', '%ORCA_AUTOMATION_BANG%')
          }
        : {})
    },
    startupCommandDelivery: 'shell-ready'
  }
}
