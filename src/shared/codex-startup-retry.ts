import type { AgentStartupShell } from './tui-agent-startup-shell'
import { tokenizeCustomCommandTemplate } from './commit-message-prompt'

const CODEX_STARTUP_RETRY_MAX_RETRIES = 2
const CODEX_STARTUP_RETRY_MIN_SECONDS = 4
const CODEX_STARTUP_RETRY_MAX_SECONDS = 12
const CODEX_STARTUP_RETRY_MESSAGE = 'Codex exited during startup; retrying...'
const CODEX_STARTUP_RETRY_FUNCTION = '__orca_codex_start'
const CODEX_STARTUP_RETRY_POSIX_PREFIX = `${CODEX_STARTUP_RETRY_FUNCTION}() { `
const CODEX_STARTUP_RETRY_POWERSHELL_PREFIX = `function ${CODEX_STARTUP_RETRY_FUNCTION} { `
const CODEX_STARTUP_RETRY_INNER_ARG = '__orca_codex_inner_command'

function quotePortableShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function extractPowerShellFunctionCommand(command: string): string | null {
  if (
    !command.startsWith(CODEX_STARTUP_RETRY_POWERSHELL_PREFIX) ||
    !command.includes(CODEX_STARTUP_RETRY_MESSAGE)
  ) {
    return null
  }
  let innerCommand = ''
  let inSingleQuote = false
  for (let index = CODEX_STARTUP_RETRY_POWERSHELL_PREFIX.length; index < command.length; index++) {
    const char = command[index]
    if (inSingleQuote) {
      innerCommand += char
      if (char === "'" && command[index + 1] === "'") {
        innerCommand += command[index + 1]
        index += 1
        continue
      }
      if (char === "'") {
        inSingleQuote = false
      }
      continue
    }
    if (char === "'") {
      inSingleQuote = true
      innerCommand += char
      continue
    }
    if (char === '}') {
      return innerCommand.trimEnd()
    }
    innerCommand += char
  }
  return null
}

function wrapCodexStartupRetry(command: string, shell: AgentStartupShell): string {
  if (shell === 'cmd') {
    return command
  }
  // Why: Codex's SQLite busy timeout exits after about five seconds when
  // another tab briefly holds shared local state. Retrying keeps that state shared.
  if (shell === 'powershell') {
    return [
      `${CODEX_STARTUP_RETRY_POWERSHELL_PREFIX}${command} }`,
      '$__orcaCodexAttempt = 0',
      'while ($true) {',
      '  $__orcaCodexStarted = Get-Date',
      '  $global:LASTEXITCODE = $null',
      `  ${CODEX_STARTUP_RETRY_FUNCTION}`,
      '  $__orcaCodexSucceeded = $?',
      '  $__orcaCodexStatus = if ($null -ne $global:LASTEXITCODE) { $global:LASTEXITCODE } elseif ($__orcaCodexSucceeded) { 0 } else { 1 }',
      '  $__orcaCodexElapsed = ((Get-Date) - $__orcaCodexStarted).TotalSeconds',
      `  if ($__orcaCodexStatus -eq 0 -or $__orcaCodexStatus -lt 0 -or $__orcaCodexStatus -ge 128 -or $__orcaCodexElapsed -lt ${CODEX_STARTUP_RETRY_MIN_SECONDS} -or $__orcaCodexElapsed -gt ${CODEX_STARTUP_RETRY_MAX_SECONDS} -or $__orcaCodexAttempt -ge ${CODEX_STARTUP_RETRY_MAX_RETRIES}) { break }`,
      '  $__orcaCodexAttempt += 1',
      `  Write-Host "${CODEX_STARTUP_RETRY_MESSAGE}"`,
      '  Start-Sleep -Seconds $__orcaCodexAttempt',
      '}',
      `Remove-Item Function:${CODEX_STARTUP_RETRY_FUNCTION} -ErrorAction SilentlyContinue`,
      '$global:LASTEXITCODE = $__orcaCodexStatus'
    ].join('; ')
  }
  const retryFunctionBody = [
    '__orca_codex_attempt=0',
    'while :; do __orca_codex_started=$(date +%s)',
    `  ${CODEX_STARTUP_RETRY_FUNCTION}`,
    '  __orca_codex_status=$?',
    '  __orca_codex_elapsed=$(($(date +%s)-__orca_codex_started))',
    `  if [ "$__orca_codex_status" -eq 0 ] || [ "$__orca_codex_status" -ge 128 ] || [ "$__orca_codex_elapsed" -lt ${CODEX_STARTUP_RETRY_MIN_SECONDS} ] || [ "$__orca_codex_elapsed" -gt ${CODEX_STARTUP_RETRY_MAX_SECONDS} ] || [ "$__orca_codex_attempt" -ge ${CODEX_STARTUP_RETRY_MAX_RETRIES} ]; then return "$__orca_codex_status"; fi`,
    '  __orca_codex_attempt=$((__orca_codex_attempt+1))',
    `  printf "%s\\n" "${CODEX_STARTUP_RETRY_MESSAGE}" >&2`,
    '  sleep "$__orca_codex_attempt"',
    'done'
  ].join('; ')
  const retryScript = [
    `${CODEX_STARTUP_RETRY_POSIX_PREFIX}${command}; }`,
    `__orca_codex_retry() { ${retryFunctionBody}; }`,
    '__orca_codex_retry',
    '__orca_codex_result=$?',
    'unset -f __orca_codex_start __orca_codex_retry 2>/dev/null || true',
    '(exit "$__orca_codex_result")'
  ].join('; ')
  // Why: POSIX platforms can still run fish as the interactive shell; submit a
  // plain sh command while preserving the original command for downstream checks.
  return [
    `sh -c ${quotePortableShellArg(retryScript)}`,
    CODEX_STARTUP_RETRY_INNER_ARG,
    quotePortableShellArg(command)
  ].join(' ')
}

export function isCodexStartupRetryWrappedCommand(command: string | null | undefined): boolean {
  return getCodexStartupRetryInnerCommand(command) !== null
}

export function getCodexStartupRetryInnerCommand(
  command: string | null | undefined
): string | null {
  const trimmed = command?.trimStart()
  if (!trimmed) {
    return null
  }
  if (trimmed.startsWith(CODEX_STARTUP_RETRY_POWERSHELL_PREFIX)) {
    return extractPowerShellFunctionCommand(trimmed)
  }
  const tokens = tokenizeCustomCommandTemplate(trimmed)
  if (!tokens.ok) {
    return null
  }
  const innerArgIndex = tokens.tokens.indexOf(CODEX_STARTUP_RETRY_INNER_ARG)
  return tokens.tokens[0] === 'sh' &&
    tokens.tokens[1] === '-c' &&
    tokens.tokens[2]?.includes(CODEX_STARTUP_RETRY_POSIX_PREFIX) === true &&
    tokens.tokens[2]?.includes(CODEX_STARTUP_RETRY_MESSAGE) === true &&
    innerArgIndex >= 0 &&
    innerArgIndex + 1 < tokens.tokens.length
    ? (tokens.tokens[innerArgIndex + 1] ?? null)
    : null
}

export function maybeWrapCodexStartupRetry(
  agent: string,
  command: string,
  shell: AgentStartupShell
): string {
  return agent === 'codex' ? wrapCodexStartupRetry(command, shell) : command
}
