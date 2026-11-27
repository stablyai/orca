import { quotePosixShellUnlessPlainNoAt } from '../../shell/launch/shell-argument-quoting'
import { encodePowerShellCommand } from '../../shell/launch/powershell-command-encoding'
import { getPosixCodexShellLaunchPreflight } from '../../shell/launch/agents/codex-shell-function'
import { getPosixClaudeShellFunction } from '../../shell/launch/agents/claude-shell-function'
import { getPowerShellAgentWrappers } from '../../shell/launch/agents/powershell-agent-wrappers'
import {
  nativeWindowsPathToPosixShellPath,
  resolveSetupRunnerCommand,
  type SetupRunnerCommandPlatform,
  type SetupRunnerShell
} from './setup-runner-command'
import { createNonSecureContextUuid } from '../../identifiers/non-secure-context-uuid'
import { quotePowerShellLiteral } from '../../shell/launch/powershell-native-argument'
import { setupCompletionMarkerPrefix } from './setup-completion-marker'
import { AGENT_STARTUP_PROMPT_ENV } from './agent-startup-prompt-env'
import { clearEnvCommand } from './tui-agent-startup-shell'
import {
  SETUP_AGENT_ARGV0_ENV,
  SETUP_AGENT_BLOCKED_MESSAGE,
  SETUP_AGENT_EXECUTABLE_ENV,
  SETUP_AGENT_NOTICE_ENV,
  SETUP_AGENT_RECHECK_ENV,
  buildPosixSetupAgentRecheck
} from './setup-agent-program'

export const SETUP_AGENT_RECHECK_TIMEOUT_SECONDS = 10

export const SETUP_AGENT_WAIT_TIMEOUT_SECONDS = 2 * 60 * 60
export const SETUP_WAIT_MESSAGE = 'Waiting for setup to finish before starting agent...'
export const SETUP_COMPLETE_MESSAGE = 'Setup finished; starting agent.'
export const SETUP_FAILED_MESSAGE_PREFIX = 'Setup failed (exit '
export const SETUP_WAIT_TIMEOUT_MESSAGE = 'Timed out waiting for setup before starting agent.'
export { SETUP_AGENT_BLOCKED_MESSAGE }
export const SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV = 'ORCA_SEQUENCED_STARTUP_COMMAND'
export const SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV = 'ORCA_SEQUENCED_STARTUP_SCRIPT'
export const SETUP_AGENT_SEQUENCE_POWERSHELL_SCRIPT_ENV = 'ORCA_SEQUENCED_POWERSHELL_SCRIPT'
export const SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV = 'ORCA_SEQUENCED_SETUP_SCRIPT'
export const SETUP_AGENT_PROMPT_ENV = [
  ...AGENT_STARTUP_PROMPT_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV
]

export type SequencedSetupAgentCommands = {
  setupCommand: string
  setupEnv?: Record<string, string>
  startupCommand: string
  startupEnv?: Record<string, string>
}

export function resolveSetupAgentSequenceLaunchCommand(
  env: Record<string, string | undefined>,
  fallbackCommand: string | undefined
): string | undefined {
  const sequencedStartup = env[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]?.trim()
  return sequencedStartup || fallbackCommand
}

export function createSetupAgentSequenceNonce(): string {
  return createNonSecureContextUuid()
}

export function createSequencedSetupAgentCommands(args: {
  runnerScriptPath: string
  startupCommand: string
  platform: SetupRunnerCommandPlatform
  shell?: SetupRunnerShell
  nonce?: string
  waitTimeoutSeconds?: number
  /** Setup also prints its completion line, so the runtime sees it finish (`isSetupTerminalRunning`). */
  completionToken?: string
}): SequencedSetupAgentCommands {
  const nonce = args.nonce ?? createSetupAgentSequenceNonce()
  const resolution = resolveSetupRunnerCommand(args.runnerScriptPath, args.platform, args.shell)
  // startupCommand is already quoted for the pane: Git Bash needs a bash gate even for batch runners,
  // which still launch through resolution.command. PowerShell cannot parse the POSIX escaping.
  const posixGateForWindowsRunner = resolution.shell === 'windows' && args.shell?.family === 'posix'
  const markerBasePath = posixGateForWindowsRunner
    ? nativeWindowsPathToPosixShellPath(resolution.runnerScriptPathForShell)
    : resolution.runnerScriptPathForShell
  // Use distinct markers for overlapping launches of one setup runner.
  const markerPath = `${markerBasePath}.${nonce}.done`
  const waitTimeoutSeconds = args.waitTimeoutSeconds ?? SETUP_AGENT_WAIT_TIMEOUT_SECONDS

  if (resolution.shell === 'windows' && !posixGateForWindowsRunner) {
    return {
      setupCommand: powerShellScriptInvocation(SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV),
      setupEnv: {
        [SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV]: buildWindowsSetupScript(
          resolution.runnerScriptPathForShell,
          markerPath,
          nonce,
          args.completionToken
        )
      },
      startupCommand: powerShellScriptInvocation(SETUP_AGENT_SEQUENCE_POWERSHELL_SCRIPT_ENV),
      startupEnv: {
        [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: args.startupCommand,
        [SETUP_AGENT_SEQUENCE_POWERSHELL_SCRIPT_ENV]: buildWindowsStartupScript(
          markerPath,
          nonce,
          waitTimeoutSeconds
        ),
        [SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]: getPowerShellAgentWrappers()
      }
    }
  }

  const startupScript = buildPosixStartupScript(markerPath, nonce, waitTimeoutSeconds)
  return {
    // Why: long worktree paths can push typed wrappers past a PTY's canonical input cap and drop their submit byte.
    setupCommand: `bash -lc 'eval "\${${SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV}:?missing}"'`,
    setupEnv: {
      [SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV]: buildPosixSetupScript(
        resolution.command,
        markerPath,
        nonce,
        args.completionToken
      )
    },
    startupCommand: `bash -lc 'eval "$${SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV}"'`,
    startupEnv: {
      [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: args.startupCommand,
      [SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]: startupScript
    }
  }
}

function buildPosixSetupScript(
  setupCommand: string,
  markerPath: string,
  nonce: string,
  completionToken?: string
): string {
  const marker = quotePosixShellUnlessPlainNoAt(markerPath)
  const tmp = quotePosixShellUnlessPlainNoAt(`${markerPath}.tmp`)
  const nonceValue = quotePosixShellUnlessPlainNoAt(nonce)

  return [
    `rm -f ${marker} ${tmp} 2>/dev/null`,
    setupCommand,
    'status=$?',
    `printf '%s:%s\\n' ${nonceValue} "$status" > ${tmp}`,
    `mv -f ${tmp} ${marker}`,
    ...(completionToken
      ? [
          `printf '\\n%s%s\\n' ${quotePosixShellUnlessPlainNoAt(setupCompletionMarkerPrefix(completionToken))} "$status"`
        ]
      : []),
    'exit "$status"'
  ].join('; ')
}

function buildPosixStartupScript(
  markerPath: string,
  nonce: string,
  waitTimeoutSeconds: number
): string {
  const marker = quotePosixShellUnlessPlainNoAt(markerPath)
  const tmp = quotePosixShellUnlessPlainNoAt(`${markerPath}.tmp`)
  const nonceValue = quotePosixShellUnlessPlainNoAt(nonce)
  const timeout = Math.max(1, Math.floor(waitTimeoutSeconds))
  const shellFunctions = getPosixCodexShellLaunchPreflight() + getPosixClaudeShellFunction()
  const script = [
    `trap 'unset ${SETUP_AGENT_PROMPT_ENV.join(' ')}' EXIT;`,
    `deadline=$((SECONDS + ${timeout}));`,
    `echo ${quotePosixShellUnlessPlainNoAt(SETUP_WAIT_MESSAGE)} >&2;`,
    'while :; do',
    `if [ -f ${marker} ]; then`,
    `IFS=: read -r seen status < ${marker} || true;`,
    `if [ "$seen" = ${nonceValue} ]; then`,
    'if [ "$status" = "0" ]; then',
    `rm -f ${marker} ${tmp} 2>/dev/null;`,
    `if [ -n "$${SETUP_AGENT_RECHECK_ENV}" ]; then`,
    `  unset ${SETUP_AGENT_EXECUTABLE_ENV};`,
    `  if [ -n "$${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}" ]; then`,
    ...buildPosixSetupAgentRecheck(SETUP_AGENT_RECHECK_TIMEOUT_SECONDS),
    '  fi;',
    `  if [ -z "$${SETUP_AGENT_EXECUTABLE_ENV}" ] || [ -z "$${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}" ]; then`,
    `    printf '%s\\n' '${SETUP_AGENT_BLOCKED_MESSAGE}' "$${SETUP_AGENT_NOTICE_ENV}" >&2; exit 1; fi;`,
    `  export ${SETUP_AGENT_EXECUTABLE_ENV} ${SETUP_AGENT_ARGV0_ENV};`,
    `else\n${shellFunctions}fi;`,
    `if [ -z "$${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}" ]; then echo '${SETUP_AGENT_BLOCKED_MESSAGE}' >&2; exit 1; fi;`,
    `echo ${quotePosixShellUnlessPlainNoAt(SETUP_COMPLETE_MESSAGE)} >&2;`,
    `eval "$${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}"; exit "$?"; fi;`,
    `rm -f ${marker} ${tmp} 2>/dev/null;`,
    `echo "${SETUP_FAILED_MESSAGE_PREFIX}\${status:-1}); skipping agent startup. See the Setup terminal for details." >&2;`,
    'exit "${status:-1}";',
    'fi;',
    'fi;',
    'if [ "$SECONDS" -ge "$deadline" ]; then',
    `echo ${quotePosixShellUnlessPlainNoAt(SETUP_WAIT_TIMEOUT_MESSAGE)} >&2;`,
    'exit 124;',
    'fi;',
    'sleep 1;',
    'done'
  ].join(' ')

  return script
}

function buildWindowsSetupScript(
  runnerScriptPath: string,
  markerPath: string,
  nonce: string,
  completionToken?: string
): string {
  // Why: delayed expansion keeps path metacharacters as data when cmd invokes the batch runner.
  return [
    `$runner = ${quotePowerShellLiteral(runnerScriptPath)}`,
    `$marker = ${quotePowerShellLiteral(markerPath)}`,
    '$tmp = $marker + ".tmp"',
    `$nonce = ${quotePowerShellLiteral(nonce)}`,
    'Remove-Item -LiteralPath $marker, $tmp -Force -ErrorAction SilentlyContinue',
    '$processInfo = [System.Diagnostics.ProcessStartInfo]::new()',
    '$processInfo.FileName = $env:ComSpec',
    '$processInfo.Arguments = \'/d /s /v:on /c ""!ORCA_SETUP_RUNNER!""\'',
    '$processInfo.UseShellExecute = $false',
    '$processInfo.EnvironmentVariables["ORCA_SETUP_RUNNER"] = $runner',
    '$process = [System.Diagnostics.Process]::Start($processInfo)',
    '$process.WaitForExit()',
    '$setupStatus = $process.ExitCode',
    '$utf8 = [System.Text.UTF8Encoding]::new($false)',
    '[System.IO.File]::WriteAllText($tmp, ($nonce + ":" + $setupStatus + [Environment]::NewLine), $utf8)',
    'Move-Item -LiteralPath $tmp -Destination $marker -Force',
    ...(completionToken
      ? [
          `Write-Output (${quotePowerShellLiteral(setupCompletionMarkerPrefix(completionToken))} + $setupStatus)`
        ]
      : []),
    'exit $setupStatus'
  ].join('; ')
}

function buildWindowsStartupScript(
  markerPath: string,
  nonce: string,
  waitTimeoutSeconds: number
): string {
  const timeout = Math.max(1, Math.floor(waitTimeoutSeconds))
  // Use PowerShell for safe bounded marker polling; native Windows runners still launch through cmd.
  return [
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
    '$tmp = $marker + ".tmp"',
    `$nonce = ${quotePowerShellLiteral(nonce)}`,
    `$deadline = (Get-Date).AddSeconds(${timeout})`,
    `[Console]::Error.WriteLine(${quotePowerShellLiteral(SETUP_WAIT_MESSAGE)})`,
    'try {',
    'while ($true) {',
    '  if (Test-Path -LiteralPath $marker) {',
    '    $content = Get-Content -LiteralPath $marker -TotalCount 1',
    '    if ($content -match "^([0-9A-Za-z_-]+):([0-9]+)$" -and $Matches[1] -eq $nonce) {',
    '      $setupStatus = [int]$Matches[2]',
    '      Remove-Item -LiteralPath $marker, $tmp -Force -ErrorAction SilentlyContinue',
    '      if ($setupStatus -ne 0) {',
    `        [Console]::Error.WriteLine("${SETUP_FAILED_MESSAGE_PREFIX}$setupStatus); skipping agent startup. See the Setup terminal for details.")`,
    '        exit $setupStatus',
    '      }',
    `      $startup = $env:${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}`,
    `      if ($env:${SETUP_AGENT_RECHECK_ENV}) {`,
    '        $pin = $null',
    '        if (![string]::IsNullOrWhiteSpace($startup)) {',
    '          $recheck = [powershell]::Create()',
    '          try {',
    `            [void]$recheck.AddScript($env:${SETUP_AGENT_RECHECK_ENV})`,
    '            $pending = $recheck.BeginInvoke()',
    `            if ($pending.AsyncWaitHandle.WaitOne(${SETUP_AGENT_RECHECK_TIMEOUT_SECONDS * 1000})) {`,
    '              try { $pin = $recheck.EndInvoke($pending) } finally { $recheck.Dispose() }',
    '            } else {',
    '              [void]$recheck.BeginStop($null, $null)',
    '            }',
    '          } catch {}',
    '        }',
    '        if (!$pin -or $pin.Count -ne 1) {',
    `          [Console]::Error.WriteLine(${quotePowerShellLiteral(SETUP_AGENT_BLOCKED_MESSAGE)})`,
    `          [Console]::Error.WriteLine($env:${SETUP_AGENT_NOTICE_ENV})`,
    '          exit 1',
    '        }',
    `        $env:${SETUP_AGENT_EXECUTABLE_ENV} = [string]$pin[0]`,
    '      }',
    '      if ([string]::IsNullOrWhiteSpace($startup)) {',
    '        [Console]::Error.WriteLine("Missing sequenced startup command.")',
    '        exit 1',
    '      }',
    `      [Console]::Error.WriteLine(${quotePowerShellLiteral(SETUP_COMPLETE_MESSAGE)})`,
    // Define the quoting wrappers after setup, which may install the agent.
    `      $wrappers = $env:${SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV}`,
    `      if ($wrappers) { Invoke-Expression $wrappers; Remove-Item Env:${SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV} }`,
    '      Invoke-Expression $startup',
    '      if ($global:LASTEXITCODE -ne $null) { exit $global:LASTEXITCODE }',
    '      if (-not $?) { exit 1 }',
    '      exit 0',
    '    }',
    '  }',
    '  if ((Get-Date) -ge $deadline) {',
    `    [Console]::Error.WriteLine(${quotePowerShellLiteral(SETUP_WAIT_TIMEOUT_MESSAGE)})`,
    '    exit 124',
    '  }',
    '  Start-Sleep -Seconds 1',
    `} } finally { ${clearEnvCommand(SETUP_AGENT_PROMPT_ENV, 'powershell')} }`
  ].join('; ')
}

// EncodedCommand is not policy-gated; omit the EDR-heavy ExecutionPolicy Bypass switch.
function powerShellScriptInvocation(name: string): string {
  const script = `if (!$env:${name}) { exit 1 }; Invoke-Expression $env:${name}`
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(script)}`
}
