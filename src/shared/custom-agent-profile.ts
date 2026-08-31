import type { AgentStartupShell } from './tui-agent-startup-shell'
import { buildShellCommandFromArgv } from './tui-agent-startup-shell'
import { encodePowerShellCommand } from './powershell-command-encoding'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'

export const CUSTOM_AGENT_PROFILES_MAX = 32
export const CUSTOM_AGENT_ARGUMENTS_MAX = 256
export const CUSTOM_AGENT_ARGUMENTS_BYTES_MAX = 16 * 1024

const PROFILE_ID_MAX = 128
const PROFILE_NAME_MAX = 80
const EXECUTABLE_MAX = 4096
const WINDOWS_ENV_VALUE_CHARS_MAX = 32_767
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

export type CustomAgentProfile = {
  id: string
  name: string
  executable: string
  args: readonly string[]
}

export type CustomAgentLaunch = {
  command: string
  env?: Record<string, string>
}

const WINDOWS_ARGV_ENV = 'ORCA_CUSTOM_AGENT_WINDOWS_ARGV_V1'

function boundedSafeString(value: unknown, max: number, trim: boolean): string | null {
  if (typeof value !== 'string' || hasControlCharacter(value)) {
    return null
  }
  const normalized = trim ? value.trim() : value
  return normalized.length > 0 && normalized.length <= max ? normalized : null
}

function normalizeArguments(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > CUSTOM_AGENT_ARGUMENTS_MAX) {
    return null
  }
  const args: string[] = []
  for (const arg of value) {
    if (typeof arg !== 'string' || hasControlCharacter(arg)) {
      return null
    }
    args.push(arg)
  }
  return new TextEncoder().encode(JSON.stringify(args)).byteLength <=
    CUSTOM_AGENT_ARGUMENTS_BYTES_MAX
    ? args
    : null
}

export function normalizeCustomAgentProfile(value: unknown): CustomAgentProfile | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const row = value as Record<string, unknown>
  const id = boundedSafeString(row.id, PROFILE_ID_MAX, true)
  const name = boundedSafeString(row.name, PROFILE_NAME_MAX, true)
  const executable = boundedSafeString(row.executable, EXECUTABLE_MAX, true)
  const args = normalizeArguments(row.args)
  if (!id || !name || !executable || !args) {
    return null
  }
  const argvBytes = new TextEncoder().encode(JSON.stringify([executable, ...args])).byteLength
  if (4 * Math.ceil(argvBytes / 3) > WINDOWS_ENV_VALUE_CHARS_MAX) {
    return null
  }
  return { id, name, executable, args }
}

export function normalizeCustomAgentProfiles(value: unknown): CustomAgentProfile[] {
  if (!Array.isArray(value)) {
    return []
  }
  const profiles: CustomAgentProfile[] = []
  const ids = new Set<string>()
  const names = new Set<string>(
    [...Object.keys(TUI_AGENT_DISPLAY_NAMES), ...Object.values(TUI_AGENT_DISPLAY_NAMES)].map(
      (name) => name.toLowerCase()
    )
  )
  for (const valueRow of value) {
    if (profiles.length >= CUSTOM_AGENT_PROFILES_MAX) {
      break
    }
    const profile = normalizeCustomAgentProfile(valueRow)
    if (!profile) {
      continue
    }
    const foldedName = profile.name.toLowerCase()
    if (ids.has(profile.id) || names.has(foldedName)) {
      continue
    }
    ids.add(profile.id)
    names.add(foldedName)
    profiles.push(profile)
  }
  return profiles
}

export function buildCustomAgentLaunch(
  profile: CustomAgentProfile,
  shell: AgentStartupShell
): CustomAgentLaunch | null {
  const normalized = normalizeCustomAgentProfile(profile)
  if (!normalized) {
    return null
  }
  const argv: [string, ...string[]] = [normalized.executable, ...normalized.args]
  return shell === 'posix'
    ? { command: buildShellCommandFromArgv(argv, shell) }
    : buildCustomAgentWindowsLaunch(argv, shell)
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function buildCustomAgentWindowsLaunch(
  argv: readonly [string, ...string[]],
  shell: 'cmd' | 'powershell'
): CustomAgentLaunch {
  const script = [
    `$payload = $env:${WINDOWS_ARGV_ENV}`,
    `Remove-Item Env:${WINDOWS_ARGV_ENV} -ErrorAction SilentlyContinue`,
    '$decodedArgv = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json',
    '$argv = @($decodedArgv)',
    'function Quote-CmdArgument([string]$value) {',
    "  $quoted = '\"'",
    '  $backslashes = 0',
    '  foreach ($character in $value.ToCharArray()) {',
    '    if ($character -eq [char]92) { $backslashes += 1; continue }',
    '    if ($character -eq [char]34) {',
    "      $quoted += (-join ('\\' * ($backslashes * 2))) + '\"\"'",
    '      $backslashes = 0',
    '      continue',
    '    }',
    "    if ($character -eq '%') {",
    "      $quoted += (-join ('\\' * ($backslashes * 2))) + '\"^%\"'",
    '      $backslashes = 0',
    '      continue',
    '    }',
    "    $quoted += (-join ('\\' * $backslashes)) + $character",
    '    $backslashes = 0',
    '  }',
    "  return $quoted + (-join ('\\' * ($backslashes * 2))) + '\"'",
    '}',
    '$agentCommand = [string]$argv[0]',
    '$escapedCommand = [Management.Automation.WildcardPattern]::Escape($agentCommand)',
    '$resolvedCommand = (Get-Command -Name $escapedCommand -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source',
    '$encodedCommand = Quote-CmdArgument $resolvedCommand',
    "$encodedArgs = @($argv | Select-Object -Skip 1 | ForEach-Object { Quote-CmdArgument ([string]$_) }) -join ' '",
    "$runnerCommand = $encodedCommand + $(if ($encodedArgs) { ' ' + $encodedArgs } else { '' })",
    "$runnerCommand = $runnerCommand.Replace('%', '%%')",
    "$runnerPath = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'orca-agent-' + [Guid]::NewGuid().ToString('N') + '.cmd')",
    "$runnerLines = @('@echo off', '@chcp 65001 >nul', $runnerCommand, 'exit /b %errorlevel%')",
    '$runnerExit = 1',
    'try {',
    '  [IO.File]::WriteAllLines($runnerPath, $runnerLines, [Text.UTF8Encoding]::new($false))',
    '  & cmd.exe /d /q /v:off /c $runnerPath',
    '  $runnerExit = $LASTEXITCODE',
    '} finally {',
    '  Remove-Item -LiteralPath $runnerPath -Force -ErrorAction SilentlyContinue',
    '}',
    'exit $runnerExit'
  ].join('\n')
  const invocation = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`
  const command =
    shell === 'cmd'
      ? `${invocation} & set "${WINDOWS_ARGV_ENV}="`
      : `${invocation}; $orcaAgentExit = $LASTEXITCODE; Remove-Item Env:${WINDOWS_ARGV_ENV} -ErrorAction SilentlyContinue; & cmd.exe /d /c exit $orcaAgentExit`
  return {
    command,
    env: { [WINDOWS_ARGV_ENV]: encodeUtf8Base64(JSON.stringify(argv)) }
  }
}

export function createCustomAgentProfileId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `custom-agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}
