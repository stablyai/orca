import { quotePosixShellUnlessPlainNoAt } from './shell-argument-quoting'
import { encodePowerShellCommand } from './powershell-command-encoding'
import { quotePowerShellLiteral } from './powershell-native-argument'
import { SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV } from './setup-agent-sequencing'
import {
  resolveSetupRunnerCommand,
  type SetupRunnerCommandPlatform,
  type SetupRunnerShell
} from './setup-runner-command'

/** Where the host that owns Setup wants `<attempt>:<status>`; it names the file, the wrapper fills it. */
export const SETUP_STATUS_FILE_ENV = 'ORCA_SETUP_STATUS_FILE'

/**
 * The Setup terminal's launcher. Only a short fixed line is typed, as main's sequenced Setup does;
 * the body (runner path, attempt, status write) stays in the environment, and the runner's exit
 * status leaves through a file, never through the terminal.
 */
export function createObservedSetupCommand(args: {
  runnerScriptPath: string
  platform: SetupRunnerCommandPlatform
  shell?: SetupRunnerShell
  attemptId: string
}): { command: string; env: Record<string, string> } {
  const resolution = resolveSetupRunnerCommand(args.runnerScriptPath, args.platform, args.shell)
  // A POSIX terminal still runs a batch runner through resolution.command behind the bash line.
  if (resolution.shell === 'windows' && args.shell?.family !== 'posix') {
    return {
      // EncodedCommand reads the same from cmd and PowerShell; it encodes only this fixed line.
      command: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(
        `Invoke-Expression $env:${SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV}`
      )}`,
      env: {
        [SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV]: windowsSetupScript(
          resolution.runnerScriptPathForShell,
          args.attemptId
        )
      }
    }
  }
  return {
    command: `bash -lc 'eval "\${${SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV}:?missing}"'`,
    env: {
      [SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV]: posixSetupScript(resolution.command, args.attemptId)
    }
  }
}

function posixSetupScript(runnerCommand: string, attemptId: string): string {
  const record = quotePosixShellUnlessPlainNoAt(`${attemptId}:`)
  return [
    `status_file=\${${SETUP_STATUS_FILE_ENV}:-}`,
    // Git Bash receives the host's C:\\ path; WSL already got a /mnt path through WSLENV.
    'status_file=${status_file//\\\\//}',
    runnerCommand,
    'status=$?',
    // The record is the host's to read; a failed write must not print into the user's terminal.
    `if [ -n "$status_file" ]; then { printf '%s%s\\n' ${record} "$status" > "$status_file.tmp" && mv -f "$status_file.tmp" "$status_file"; } 2>/dev/null; fi`,
    'exit "$status"'
  ].join('; ')
}

function windowsSetupScript(runnerScriptPath: string, attemptId: string): string {
  // The batch runner's own exit code, as main's Windows Setup takes it; delayed expansion keeps path metacharacters as data.
  return [
    '$processInfo = [System.Diagnostics.ProcessStartInfo]::new()',
    '$processInfo.FileName = $env:ComSpec',
    '$processInfo.Arguments = \'/d /s /v:on /c ""!ORCA_SETUP_RUNNER!""\'',
    '$processInfo.UseShellExecute = $false',
    `$processInfo.EnvironmentVariables["ORCA_SETUP_RUNNER"] = ${quotePowerShellLiteral(runnerScriptPath)}`,
    '$process = [System.Diagnostics.Process]::Start($processInfo)',
    '$process.WaitForExit()',
    '$setupStatus = $process.ExitCode',
    `$statusFile = $env:${SETUP_STATUS_FILE_ENV}`,
    'if ($statusFile) { try {',
    '$utf8 = [System.Text.UTF8Encoding]::new($false)',
    `[System.IO.File]::WriteAllText($statusFile + ".tmp", (${quotePowerShellLiteral(`${attemptId}:`)} + $setupStatus + [Environment]::NewLine), $utf8)`,
    'Move-Item -LiteralPath ($statusFile + ".tmp") -Destination $statusFile -Force -ErrorAction Stop',
    '} catch {} }',
    'exit $setupStatus'
  ].join('; ')
}
