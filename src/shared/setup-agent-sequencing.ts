import {
  resolveSetupRunnerCommand,
  type SetupRunnerCommandPlatform,
  type SetupRunnerCommandShell
} from './setup-runner-command'

const DEFAULT_WAIT_TIMEOUT_SECONDS = 2 * 60 * 60
export const SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV = 'ORCA_SEQUENCED_STARTUP_COMMAND'

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
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function createSequencedSetupAgentCommands(args: {
  runnerScriptPath: string
  startupCommand: string
  platform: SetupRunnerCommandPlatform
  nonce?: string
  waitTimeoutSeconds?: number
}): SequencedSetupAgentCommands {
  const nonce = args.nonce ?? createSetupAgentSequenceNonce()
  const resolution = resolveSetupRunnerCommand(args.runnerScriptPath, args.platform)
  // Why: overlapping gated launches of the same setup runner must not race on
  // a shared completion marker.
  const markerPath = `${resolution.runnerScriptPathForShell}.${nonce}.done`
  const waitTimeoutSeconds = args.waitTimeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS

  if (resolution.shell === 'windows') {
    return {
      setupCommand: buildWindowsSetupCommand(resolution.command, markerPath, nonce),
      startupCommand: buildWindowsStartupCommand(markerPath, nonce, waitTimeoutSeconds),
      startupEnv: {
        [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: args.startupCommand
      }
    }
  }

  return {
    setupCommand: buildPosixSetupCommand(resolution.command, markerPath, nonce),
    startupCommand: buildPosixStartupCommand(
      args.startupCommand,
      markerPath,
      nonce,
      waitTimeoutSeconds
    ),
    startupEnv: {
      [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: args.startupCommand
    }
  }
}

function buildPosixSetupCommand(setupCommand: string, markerPath: string, nonce: string): string {
  const marker = quotePosixArg(markerPath)
  const tmp = quotePosixArg(`${markerPath}.tmp`)
  const nonceValue = quotePosixArg(nonce)

  const script = [
    `rm -f ${marker} ${tmp} 2>/dev/null`,
    `( ${setupCommand} )`,
    'status=$?',
    `printf '%s:%s\\n' ${nonceValue} "$status" > ${tmp}`,
    `mv -f ${tmp} ${marker}`,
    'exit "$status"'
  ].join('; ')

  return `bash -lc ${quotePosixArg(script)}`
}

function buildPosixStartupCommand(
  startupCommand: string,
  markerPath: string,
  nonce: string,
  waitTimeoutSeconds: number
): string {
  const marker = quotePosixArg(markerPath)
  const tmp = quotePosixArg(`${markerPath}.tmp`)
  const nonceValue = quotePosixArg(nonce)
  const timeout = Math.max(1, Math.floor(waitTimeoutSeconds))
  const startupSuccessCommand = buildPosixStartupSuccessCommand(startupCommand)
  // Why: the PTY launch path feeds this command through an interactive shell,
  // so keeping the wrapper on one line avoids visible `quote>` continuation
  // prompts while still preserving valid `while`/`if` shell syntax.
  const script = [
    `deadline=$((SECONDS + ${timeout}));`,
    'echo "Waiting for setup to finish before starting agent..." >&2;',
    'while :; do',
    `if [ -f ${marker} ]; then`,
    `IFS=: read -r seen status < ${marker} || true;`,
    `if [ "$seen" = ${nonceValue} ]; then`,
    `rm -f ${marker} ${tmp} 2>/dev/null;`,
    `if [ "$status" = "0" ]; then if [ -n "\${${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}:-}" ]; then eval "\$${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}"; exit "$?"; else ${startupSuccessCommand}; fi; fi;`,
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

  return `bash -lc ${quotePosixArg(script)}`
}

function buildPosixStartupSuccessCommand(startupCommand: string): string {
  if (
    hasUnquotedPosixCommandSeparator(startupCommand) ||
    hasLeadingPosixEnvAssignment(startupCommand)
  ) {
    return `eval ${quotePosixArg(startupCommand)}; exit "$?"`
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

function buildWindowsSetupCommand(setupCommand: string, markerPath: string, nonce: string): string {
  return wrapCmd([
    `set "ORCA_SETUP_MARKER=${escapeCmdSetValue(markerPath)}"`,
    `set "ORCA_SETUP_NONCE=${escapeCmdSetValue(nonce)}"`,
    'del /f /q "!ORCA_SETUP_MARKER!" "!ORCA_SETUP_MARKER!.tmp" 2>nul',
    `call ${setupCommand}`,
    'set "ORCA_SETUP_STATUS=!ERRORLEVEL!"',
    '> "!ORCA_SETUP_MARKER!.tmp" echo !ORCA_SETUP_NONCE!:!ORCA_SETUP_STATUS!',
    'move /y "!ORCA_SETUP_MARKER!.tmp" "!ORCA_SETUP_MARKER!" >nul',
    'exit /b !ORCA_SETUP_STATUS!'
  ])
}

function buildWindowsStartupCommand(
  markerPath: string,
  nonce: string,
  waitTimeoutSeconds: number
): string {
  const timeout = Math.max(1, Math.floor(waitTimeoutSeconds))
  // Why: native Windows setup runners launch through cmd.exe, but PowerShell
  // gives us safe bounded file polling/parsing without a fragile batch label loop.
  const script = [
    '$marker = $env:ORCA_SETUP_MARKER',
    '$tmp = $marker + ".tmp"',
    '$nonce = $env:ORCA_SETUP_NONCE',
    `$deadline = (Get-Date).AddSeconds(${timeout})`,
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

  return wrapCmd([
    `set "ORCA_SETUP_MARKER=${escapeCmdSetValue(markerPath)}"`,
    `set "ORCA_SETUP_NONCE=${escapeCmdSetValue(nonce)}"`,
    'echo Waiting for setup to finish before starting agent... 1>&2',
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ${quoteWindowsArg(script)}`,
    'set "ORCA_SETUP_STATUS=!ERRORLEVEL!"',
    'exit /b !ORCA_SETUP_STATUS!'
  ])
}

function wrapCmd(parts: string[]): string {
  return `cmd.exe /d /s /v:on /c ${quoteWindowsArg(parts.join(' & '))}`
}

function quotePosixArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function escapeCmdSetValue(value: string): string {
  return value.replace(/"/g, '""').replace(/[%!^]/g, (char) => `^${char}`)
}

export function getSetupAgentSequenceShellForTests(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform
): SetupRunnerCommandShell {
  return resolveSetupRunnerCommand(runnerScriptPath, platform).shell
}
