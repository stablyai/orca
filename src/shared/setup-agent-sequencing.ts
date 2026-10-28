import { quotePosixShellUnlessPlainNoAt } from './shell-argument-quoting'
import { encodePowerShellCommand } from './powershell-command-encoding'
import { getPosixCodexShellLaunchPreflight } from './codex-shell-function'
import { getPosixClaudeShellFunction } from './claude-shell-function'
import {
  nativeWindowsPathToPosixShellPath,
  resolveSetupRunnerCommand,
  type SetupRunnerCommandPlatform,
  type SetupRunnerShell
} from './setup-runner-command'
import { createNonSecureContextUuid } from './non-secure-context-uuid'
import { quotePowerShellLiteral } from './powershell-native-argument'

const DEFAULT_WAIT_TIMEOUT_SECONDS = 2 * 60 * 60
export const SETUP_COMPLETE_MESSAGE = 'Setup finished; starting agent.'
export const SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV = 'ORCA_SEQUENCED_STARTUP_COMMAND'
export const SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV = 'ORCA_SEQUENCED_STARTUP_SCRIPT'

export type SequencedSetupAgentCommands = {
  setupCommand: string
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
  const waitTimeoutSeconds = args.waitTimeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS

  if (resolution.shell === 'windows' && !posixGateForWindowsRunner) {
    return {
      setupCommand: buildWindowsSetupCommand(
        resolution.runnerScriptPathForShell,
        markerPath,
        nonce
      ),
      startupCommand: buildWindowsStartupCommand(markerPath, nonce, waitTimeoutSeconds),
      startupEnv: {
        [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: args.startupCommand
      }
    }
  }

  const startupScript = buildPosixStartupScript(
    args.startupCommand,
    markerPath,
    nonce,
    waitTimeoutSeconds
  )
  return {
    setupCommand: buildPosixSetupCommand(resolution.command, markerPath, nonce),
    // Why: long worktree paths can push the gate past a PTY's canonical input cap and drop its submit byte.
    startupCommand: `bash -lc 'eval "$${SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV}"'`,
    startupEnv: {
      [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: args.startupCommand,
      [SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]: startupScript
    }
  }
}

function buildPosixSetupCommand(setupCommand: string, markerPath: string, nonce: string): string {
  const marker = quotePosixShellUnlessPlainNoAt(markerPath)
  const tmp = quotePosixShellUnlessPlainNoAt(`${markerPath}.tmp`)
  const nonceValue = quotePosixShellUnlessPlainNoAt(nonce)

  // Why no `( … )`: this is typed into the user's line editor, where autopair widgets corrupt it (#18059).
  const script = [
    `rm -f ${marker} ${tmp} 2>/dev/null`,
    setupCommand,
    'status=$?',
    `printf '%s:%s\\n' ${nonceValue} "$status" > ${tmp}`,
    `mv -f ${tmp} ${marker}`,
    'exit "$status"'
  ].join('; ')

  return `bash -lc ${quotePosixShellUnlessPlainNoAt(script)}`
}

function buildPosixStartupScript(
  startupCommand: string,
  markerPath: string,
  nonce: string,
  waitTimeoutSeconds: number
): string {
  const marker = quotePosixShellUnlessPlainNoAt(markerPath)
  const tmp = quotePosixShellUnlessPlainNoAt(`${markerPath}.tmp`)
  const nonceValue = quotePosixShellUnlessPlainNoAt(nonce)
  const timeout = Math.max(1, Math.floor(waitTimeoutSeconds))
  const startupSuccessCommand = buildPosixStartupSuccessCommand(startupCommand)
  // Keep the interactive wrapper one line to avoid visible quote-continuation prompts.
  const script = [
    `deadline=$((SECONDS + ${timeout}));`,
    'echo "Waiting for setup to finish before starting agent..." >&2;',
    'while :; do',
    `if [ -f ${marker} ]; then`,
    `IFS=: read -r seen status < ${marker} || true;`,
    `if [ "$seen" = ${nonceValue} ]; then`,
    `rm -f ${marker} ${tmp} 2>/dev/null;`,
    // Announce success so “Waiting for setup...” does not linger. Install launch functions only after setup
    // may have supplied codex; fresh bash -lc does not read Orca’s wrapper.
    `if [ "$status" = "0" ]; then echo ${quotePosixShellUnlessPlainNoAt(SETUP_COMPLETE_MESSAGE)} >&2;\n${getPosixCodexShellLaunchPreflight() + getPosixClaudeShellFunction()}if [ -n "\${${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}:-}" ]; then eval "\$${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}"; exit "$?"; else ${startupSuccessCommand}; fi; fi;`,
    'echo "Setup failed; skipping agent startup." >&2;',
    'exit "${status:-1}";',
    'fi;',
    'fi;',
    'if [ "$SECONDS" -ge "$deadline" ]; then',
    'echo "Timed out waiting for setup before starting agent." >&2;',
    'exit 124;',
    'fi;',
    'sleep 1;',
    'done'
  ].join(' ')

  return script
}

function buildPosixStartupSuccessCommand(startupCommand: string): string {
  if (
    hasUnquotedPosixCommandSeparator(startupCommand) ||
    hasLeadingPosixEnvAssignment(startupCommand)
  ) {
    return `eval ${quotePosixShellUnlessPlainNoAt(startupCommand)}; exit "$?"`
  }
  return `exec ${startupCommand}`
}

function hasLeadingPosixEnvAssignment(command: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(command.trimStart())
}

function hasUnquotedPosixCommandSeparator(command: string): boolean {
  let quote: "'" | '"' | null = null
  let escaped = false
  for (const char of command) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === ';' || char === '&' || char === '|' || char === '\n' || char === '\r') {
      return true
    }
  }
  return false
}

function buildWindowsSetupCommand(
  runnerScriptPath: string,
  markerPath: string,
  nonce: string
): string {
  // Why: delayed expansion keeps path metacharacters as data when cmd invokes the batch runner.
  const script = [
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
    'exit $setupStatus'
  ].join('; ')

  return encodePowerShellInvocation(script)
}

function buildWindowsStartupCommand(
  markerPath: string,
  nonce: string,
  waitTimeoutSeconds: number
): string {
  const timeout = Math.max(1, Math.floor(waitTimeoutSeconds))
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
    '$tmp = $marker + ".tmp"',
    `$nonce = ${quotePowerShellLiteral(nonce)}`,
    `$deadline = (Get-Date).AddSeconds(${timeout})`,
    '[Console]::Error.WriteLine("Waiting for setup to finish before starting agent...")',
    'while ($true) {',
    '  if (Test-Path -LiteralPath $marker) {',
    '    $content = Get-Content -LiteralPath $marker -TotalCount 1',
    '    if ($content -match "^([0-9A-Za-z_-]+):([0-9]+)$" -and $Matches[1] -eq $nonce) {',
    '      $setupStatus = [int]$Matches[2]',
    '      Remove-Item -LiteralPath $marker, $tmp -Force -ErrorAction SilentlyContinue',
    '      if ($setupStatus -ne 0) {',
    '        [Console]::Error.WriteLine("Setup failed; skipping agent startup.")',
    '        exit $setupStatus',
    '      }',
    `      $startup = $env:${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}`,
    '      if ([string]::IsNullOrWhiteSpace($startup)) {',
    '        [Console]::Error.WriteLine("Missing sequenced startup command.")',
    '        exit 1',
    '      }',
    `      [Console]::Error.WriteLine(${quotePowerShellLiteral(SETUP_COMPLETE_MESSAGE)})`,
    '      Invoke-Expression $startup',
    '      if ($global:LASTEXITCODE -ne $null) { exit $global:LASTEXITCODE }',
    '      if (-not $?) { exit 1 }',
    '      exit 0',
    '    }',
    '  }',
    '  if ((Get-Date) -ge $deadline) {',
    '    [Console]::Error.WriteLine("Timed out waiting for setup before starting agent.")',
    '    exit 124',
    '  }',
    '  Start-Sleep -Seconds 1',
    '}'
  ].join('; ')

  return encodePowerShellInvocation(script)
}

// EncodedCommand is not policy-gated; omit the EDR-heavy ExecutionPolicy Bypass switch.
// Keep base64 because terminal panes reparse the command.
function encodePowerShellInvocation(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(script)}`
}
