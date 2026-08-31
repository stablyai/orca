import { encodePowerShellCommand } from './powershell-command-encoding'
import {
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  setupStartedPath
} from './setup-agent-sequencing-env'

/** Shell fragments for the native-Windows half of the setup-to-agent gate. Both sides run under
 *  PowerShell so the marker write and the bounded poll stay parseable without a batch label loop. */
export function buildWindowsSetupCommand(
  runnerScriptPath: string,
  markerPath: string,
  nonce: string
): string {
  // Why: delayed expansion keeps path metacharacters as data when cmd invokes the batch runner.
  // Why: the status write lives in `finally` for the same reason the POSIX side uses an EXIT
  // trap — a terminated runner must still record an outcome for the waiting agent terminal.
  const script = [
    `$runner = ${quotePowerShellString(runnerScriptPath)}`,
    `$marker = ${quotePowerShellString(markerPath)}`,
    '$tmp = $marker + ".tmp"',
    `$started = ${quotePowerShellString(setupStartedPath(markerPath))}`,
    `$nonce = ${quotePowerShellString(nonce)}`,
    '$utf8 = [System.Text.UTF8Encoding]::new($false)',
    'Remove-Item -LiteralPath $marker, $tmp, $started -Force -ErrorAction SilentlyContinue',
    '[System.IO.File]::WriteAllText($started, ($nonce + [Environment]::NewLine), $utf8)',
    '$setupStatus = 1',
    'try {',
    '  $processInfo = [System.Diagnostics.ProcessStartInfo]::new()',
    '  $processInfo.FileName = $env:ComSpec',
    '  $processInfo.Arguments = \'/d /s /v:on /c ""!ORCA_SETUP_RUNNER!""\'',
    '  $processInfo.UseShellExecute = $false',
    '  $processInfo.EnvironmentVariables["ORCA_SETUP_RUNNER"] = $runner',
    '  $process = [System.Diagnostics.Process]::Start($processInfo)',
    '  $process.WaitForExit()',
    '  $setupStatus = $process.ExitCode',
    '} finally {',
    '  [System.IO.File]::WriteAllText($tmp, ($nonce + ":" + $setupStatus + [Environment]::NewLine), $utf8)',
    '  Move-Item -LiteralPath $tmp -Destination $marker -Force',
    '}',
    'exit $setupStatus'
  ].join('; ')

  return encodePowerShellInvocation(script)
}

export function buildWindowsStartupCommand(
  markerPath: string,
  nonce: string,
  waitTimeoutSeconds: number,
  startGraceSeconds: number,
  progressIntervalSeconds: number
): string {
  const timeout = Math.max(1, Math.floor(waitTimeoutSeconds))
  const grace = Math.max(1, Math.floor(startGraceSeconds))
  const progressInterval = Math.max(1, Math.floor(progressIntervalSeconds))
  // Why: native Windows setup runners launch through cmd.exe, but PowerShell
  // gives us safe bounded file polling/parsing without a fragile batch label loop.
  const script = [
    `$marker = ${quotePowerShellString(markerPath)}`,
    'if ([string]::IsNullOrWhiteSpace($marker)) {',
    '  [Console]::Error.WriteLine("Missing setup marker path.")',
    '  exit 1',
    '}',
    '$tmp = $marker + ".tmp"',
    `$started = ${quotePowerShellString(setupStartedPath(markerPath))}`,
    `$nonce = ${quotePowerShellString(nonce)}`,
    '$begunAt = Get-Date',
    `$deadline = $begunAt.AddSeconds(${timeout})`,
    `$startDeadline = $begunAt.AddSeconds(${grace})`,
    `$nextReport = $begunAt.AddSeconds(${progressInterval})`,
    '$setupStarted = $false',
    '[Console]::Error.WriteLine("Waiting for setup to finish before starting agent...")',
    '$launchAgent = {',
    `  $startup = $env:${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}`,
    '  if ([string]::IsNullOrWhiteSpace($startup)) {',
    '    [Console]::Error.WriteLine("Missing sequenced startup command.")',
    '    exit 1',
    '  }',
    '  Invoke-Expression $startup',
    '  if ($global:LASTEXITCODE -ne $null) { exit $global:LASTEXITCODE }',
    '  if (-not $?) { exit 1 }',
    '  exit 0',
    '}',
    'while ($true) {',
    '  if (Test-Path -LiteralPath $marker) {',
    '    $content = Get-Content -LiteralPath $marker -TotalCount 1',
    '    if ($content -match "^([0-9A-Za-z_-]+):([0-9]+)$" -and $Matches[1] -eq $nonce) {',
    '      $setupStatus = [int]$Matches[2]',
    '      Remove-Item -LiteralPath $marker, $tmp, $started -Force -ErrorAction SilentlyContinue',
    '      if ($setupStatus -ne 0) {',
    '        [Console]::Error.WriteLine("Setup failed; skipping agent startup. Setup exited with status $setupStatus; open the Setup tab for its output, then start the agent yourself once it is fixed.")',
    '        exit $setupStatus',
    '      }',
    '      & $launchAgent',
    '    }',
    '  }',
    '  if (-not $setupStarted -and (Test-Path -LiteralPath $started)) {',
    '    $setupStarted = $true',
    '    [Console]::Error.WriteLine("Setup started; waiting for it to finish.")',
    '  }',
    '  if (-not $setupStarted -and (Get-Date) -ge $startDeadline) {',
    `    [Console]::Error.WriteLine("Setup never reported starting within ${grace}s; the agent was not started because setup could not be verified. Open the Setup tab and retry once setup is running.")`,
    '    exit 125',
    '  }',
    '  if ((Get-Date) -ge $deadline) {',
    `    [Console]::Error.WriteLine("Timed out waiting for setup before starting agent. Waited ${timeout}s without a result; the agent was not started. Open the Setup tab for its output.")`,
    '    exit 124',
    '  }',
    '  if ((Get-Date) -ge $nextReport) {',
    `    $nextReport = (Get-Date).AddSeconds(${progressInterval})`,
    '    $elapsed = [int]((Get-Date) - $begunAt).TotalSeconds',
    '    [Console]::Error.WriteLine("Still waiting for setup to finish before starting agent... (${elapsed}s elapsed)")',
    '  }',
    '  Start-Sleep -Seconds 1',
    '}'
  ].join('; ')

  return encodePowerShellInvocation(script)
}

function encodePowerShellInvocation(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
