import { encodePowerShellCommand } from '../../shell/launch/powershell-command-encoding'
import { quotePowerShellLiteral } from '../../shell/launch/powershell-native-argument'

export function buildWindowsStartupCommand(
  markerPath: string,
  nonce: string,
  waitTimeoutSeconds: number,
  startupShell: 'posix' | 'cmd' | 'powershell' = 'powershell',
  failure: string,
  startupCommandEnv: string,
  completeMessage: string
): string {
  // Use PowerShell for safe bounded marker polling; native Windows runners still launch through cmd.
  const script = [
    // User startup may invoke policy-gated .ps1; apply relief in-payload to avoid the flagged command-line switch.
    // Silence/restore module-autoload progress so stderr stays clean. Stop routes nonterminating autoload errors
    // to a reporting catch; never rethrow and abort startup over a broken security module.
    "$orcaProgress = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'",
    'try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction Stop } ' +
      'catch { [Console]::Error.WriteLine("Orca: could not relax the execution policy for this " + ' +
      '"session (" + $_.FullyQualifiedErrorId + "). A startup command that runs a .ps1 " + ' +
      '"may be blocked.") }',
    '$ProgressPreference = $orcaProgress',
    `$marker = ${quotePowerShellLiteral(markerPath)}`,
    'if ([string]::IsNullOrWhiteSpace($marker)) {',
    '  [Console]::Error.WriteLine("Missing setup marker path.")',
    '  exit 1',
    '}',
    `$nonce = ${quotePowerShellLiteral(nonce)}`,
    `$deadline = (Get-Date).AddSeconds(${Math.max(1, Math.floor(waitTimeoutSeconds))})`,
    '[Console]::Error.WriteLine("Waiting for setup to finish before starting agent...")',
    'while ($true) {',
    '  if (Test-Path -LiteralPath $marker) {',
    '    $content = Get-Content -LiteralPath $marker -TotalCount 1',
    '    if ($content -match "^([0-9A-Za-z_-]+):([0-9]+)$" -and $Matches[1] -eq $nonce) {',
    '      $setupStatus = [int]$Matches[2]',
    '      if ($setupStatus -ne 0) {',
    `        [Console]::Error.WriteLine(${quotePowerShellLiteral(failure)})`,
    '        exit $setupStatus',
    '      }',
    `      $startup = $env:${startupCommandEnv}`,
    '      if ([string]::IsNullOrWhiteSpace($startup)) {',
    '        [Console]::Error.WriteLine("Missing sequenced startup command.")',
    '        exit 1',
    '      }',
    `      [Console]::Error.WriteLine(${quotePowerShellLiteral(completeMessage)})`,
    ...(startupShell === 'cmd'
      ? [
          '      $info = [System.Diagnostics.ProcessStartInfo]::new()',
          '      $info.FileName = $env:ComSpec',
          `      $info.Arguments = '/d /s /c "' + $startup + '"'`,
          '      $info.UseShellExecute = $false',
          '      $child = [System.Diagnostics.Process]::Start($info); $child.WaitForExit(); exit $child.ExitCode'
        ]
      : ['      Invoke-Expression $startup']),
    '      if ($global:LASTEXITCODE -ne $null) { exit $global:LASTEXITCODE }',
    '      if (-not $?) { exit 1 }',
    '      exit 0',
    '    }',
    '  }',
    '  if ((Get-Date) -ge $deadline) {',
    `    [Console]::Error.WriteLine(${quotePowerShellLiteral(failure)})`,
    '    exit 124',
    '  }',
    '  Start-Sleep -Seconds 1',
    '}'
  ].join('; ')

  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(script)}`
}
