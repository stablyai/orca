import { encodePowerShellCommand } from './powershell-command-encoding'

// Why: `cmd.exe /c "<path>"` is typed into the terminal's shell, so the path is parsed twice.
// cmd expands %VAR% even inside quotes (no escape exists on the command line), and PowerShell
// only re-quotes a native-command argument that contains whitespace — so a space-free path
// carrying any of these reaches cmd unquoted, or is rewritten by PowerShell's own expandable
// -string rules ($ interpolation, ` escapes) before cmd ever sees it.
const WINDOWS_RUNNER_PATH_CMD_GUARD_PATTERN = /[%&|<>^()!,;=$`]/

export function windowsRunnerPathNeedsCmdGuard(runnerScriptPath: string): boolean {
  return WINDOWS_RUNNER_PATH_CMD_GUARD_PATTERN.test(runnerScriptPath)
}

/**
 * Launches a native Windows runner script whose path cannot be quoted safely on a
 * `cmd.exe /c` command line. The path travels as an environment variable and is
 * substituted by delayed expansion, which cmd does not re-scan for metacharacters.
 */
export function buildWindowsCmdRunnerDelayedLaunchCommand(runnerScriptPath: string): string {
  const script = [
    `$runner = ${quotePowerShellString(runnerScriptPath)}`,
    // Why: an empty value would silently degrade to `cmd /c ""`, which exits 0 without running setup.
    'if ([string]::IsNullOrEmpty($runner)) { exit 1 }',
    '$processInfo = [System.Diagnostics.ProcessStartInfo]::new()',
    '$processInfo.FileName = $env:ComSpec',
    "if (-not $processInfo.FileName) { $processInfo.FileName = 'cmd.exe' }",
    // Why: /s strips exactly the outer quote pair, leaving "!ORCA_SETUP_RUNNER!" for /v:on to substitute verbatim.
    '$processInfo.Arguments = \'/d /s /v:on /c ""!ORCA_SETUP_RUNNER!""\'',
    // Why: no redirection means stdio is inherited, so setup output still reaches the ConPTY.
    '$processInfo.UseShellExecute = $false',
    '$processInfo.EnvironmentVariables["ORCA_SETUP_RUNNER"] = $runner',
    '$process = [System.Diagnostics.Process]::Start($processInfo)',
    '$process.WaitForExit()',
    'exit $process.ExitCode'
  ].join('; ')

  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
