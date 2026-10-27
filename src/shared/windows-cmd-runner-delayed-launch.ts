import { encodePowerShellCommand } from './powershell-command-encoding'
import { quotePowerShellLiteral } from './powershell-native-argument'

// Pane shells parse before cmd: cmd expands %VAR% inside quotes, while PowerShell can leave space-free native arguments unquoted or expand $/backticks first.
const WINDOWS_RUNNER_PATH_CMD_GUARD_PATTERN = /[%&|<>^()!,;=$`]/

export function windowsRunnerPathNeedsCmdGuard(runnerScriptPath: string): boolean {
  return WINDOWS_RUNNER_PATH_CMD_GUARD_PATTERN.test(runnerScriptPath)
}

/** Carry unsafe runner paths in env and substitute with cmd delayed expansion, which does not rescan metacharacters. */
export function buildWindowsCmdRunnerDelayedLaunchCommand(runnerScriptPath: string): string {
  const script = [
    `$runner = ${quotePowerShellLiteral(runnerScriptPath)}`,
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

  // EncodedCommand is not policy-gated, so omit noisy no-op Bypass. Base64 still shields this pane-typed command from the outer shell.
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(script)}`
}
