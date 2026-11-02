import { getPowerShellClaudeShellFunction } from './claude-shell-function'
import { getPowerShellCodexShellLaunchPreflight } from './codex-shell-function'
import { getPowerShellEscapeNativeArgsFunction } from './powershell-native-argument'
import {
  getPowerShellSavedRestoreFunctions,
  powerShellSavedRestoreCheck
} from './saved-restore-dispatch'

// As agent-shell-functions.ts: a pass-through exists only so a saved restore can check where the
// invocation runs. Claude has its own function only in account panes.
const POWERSHELL_PASS_THROUGH = `$orcaPassThrough = {
    $n = $MyInvocation.MyCommand.Name
    ${powerShellSavedRestoreCheck('$n')}
    $b = Get-Command $n -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1
    $a = @(__OrcaEscapeNativeArgs $b.Source $args)
    if ($MyInvocation.ExpectingInput) { $input | & $b.Source @a } else { & $b.Source @a }
    $global:LASTEXITCODE = $LASTEXITCODE
}
foreach ($n in 'claude', 'opencode', 'opencode2') {
    $c = Get-Command $n -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c -and $c.CommandType -in @('Application', 'ExternalScript') -and [IO.Path]::IsPathRooted($c.Source) -and
        -not ($n -eq 'claude' -and $env:ORCA_CLAUDE_PROFILE_POINTER)) { Set-Item "Function:Global:$n" $orcaPassThrough }
}
Remove-Variable orcaPassThrough, n, c -ErrorAction SilentlyContinue`

/** Orca's PowerShell agent wrappers, after the argument escaping and restore check they call. */
export function getPowerShellAgentWrappers(): string {
  return [
    getPowerShellEscapeNativeArgsFunction(),
    getPowerShellSavedRestoreFunctions(),
    getPowerShellCodexShellLaunchPreflight(),
    getPowerShellClaudeShellFunction(),
    POWERSHELL_PASS_THROUGH
  ].join('\n')
}
