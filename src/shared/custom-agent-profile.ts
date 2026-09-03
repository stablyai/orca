import type { AgentStartupShell } from './tui-agent-startup-shell'
import { buildShellCommandFromArgv } from './tui-agent-startup-shell'
import { quoteWindowsCmdArgument } from './child-process/windows-command-line'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'

export const CUSTOM_AGENT_PROFILES_MAX = 32
const CUSTOM_AGENT_ARGUMENTS_MAX = 256
const CUSTOM_AGENT_ARGUMENTS_BYTES_MAX = 16 * 1024

const PROFILE_ID_MAX = 128
const PROFILE_NAME_MAX = 80
const EXECUTABLE_MAX = 4096
const WINDOWS_ENV_VALUE_CHARS_MAX = 32_767

function fitsWindowsEnvironmentValue(argv: readonly string[]): boolean {
  return buildWindowsRunnerPayload(argv).length <= WINDOWS_ENV_VALUE_CHARS_MAX
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

export type CustomAgentProfile = {
  id: string
  name: string
  baseAgent?: TuiAgent
  baseAgentExecutable?: string
  executable: string
  args: readonly string[]
  enabled?: boolean
  isDefault?: boolean
}

export type CustomAgentLaunch = {
  command: string
  env?: Record<string, string>
}

const WINDOWS_RUNNER_ENV = 'ORCA_CUSTOM_AGENT_WINDOWS_RUNNER_V1'
const WINDOWS_EXECUTABLE_ENV = 'ORCA_CUSTOM_AGENT_WINDOWS_EXECUTABLE_V1'

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
  const baseAgentExecutable = boundedSafeString(row.baseAgentExecutable, EXECUTABLE_MAX, true)
  const args = normalizeArguments(row.args)
  if (!id || !name || !executable || !args) {
    return null
  }
  if (!fitsWindowsEnvironmentValue([executable, ...args])) {
    return null
  }
  const baseAgent =
    isTuiAgent(row.baseAgent) && baseAgentExecutable === executable ? row.baseAgent : null
  const enabled = row.enabled !== false
  return {
    id,
    name,
    ...(baseAgent ? { baseAgent, baseAgentExecutable: executable } : {}),
    executable,
    args,
    ...(!enabled ? { enabled: false } : {}),
    ...(enabled && row.isDefault === true ? { isDefault: true } : {})
  }
}

export function normalizeCustomAgentProfiles(value: unknown): CustomAgentProfile[] {
  if (!Array.isArray(value)) {
    return []
  }
  const profiles: CustomAgentProfile[] = []
  const ids = new Set<string>()
  let hasDefault = false
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
    if (profile.isDefault) {
      if (hasDefault) {
        delete profile.isDefault
      } else {
        hasDefault = true
      }
    }
    ids.add(profile.id)
    names.add(foldedName)
    profiles.push(profile)
  }
  return profiles
}

export function isCustomAgentProfileEnabled(profile: CustomAgentProfile): boolean {
  return profile.enabled !== false
}

export function findEnabledCustomAgentProfile(
  profiles: unknown,
  profileId: string | null | undefined,
  baseAgent: TuiAgent
): CustomAgentProfile | null {
  if (!profileId) {
    return null
  }
  const profile = normalizeCustomAgentProfiles(profiles).find((entry) => entry.id === profileId)
  return profile && isCustomAgentProfileEnabled(profile) && profile.baseAgent === baseAgent
    ? profile
    : null
}

export function getDefaultCustomAgentProfile(profiles: unknown): CustomAgentProfile | null {
  return normalizeCustomAgentProfiles(profiles).find((profile) => profile.isDefault) ?? null
}

export function setDefaultCustomAgentProfile(
  profiles: readonly CustomAgentProfile[],
  profileId: string | null
): CustomAgentProfile[] {
  return profiles.map((profile) => {
    const { isDefault: _isDefault, ...rest } = profile
    return profile.id === profileId && isCustomAgentProfileEnabled(profile)
      ? { ...rest, isDefault: true }
      : rest
  })
}

export function buildCustomAgentLaunch(
  profile: CustomAgentProfile,
  shell: AgentStartupShell,
  additionalArgs: readonly string[] = []
): CustomAgentLaunch {
  const argv: [string, ...string[]] = [profile.executable, ...profile.args, ...additionalArgs]
  if (shell !== 'posix' && !fitsWindowsEnvironmentValue(argv)) {
    throw new RangeError('Custom agent launch arguments exceed the Windows environment limit.')
  }
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

function buildWindowsRunnerPayload(argv: readonly string[]): string {
  const args = argv.slice(1).map(quoteWindowsCmdArgument).join(' ').replaceAll('%', '%%')
  const command = `"%${WINDOWS_EXECUTABLE_ENV}%"${args ? ` ${args}` : ''}`
  return encodeUtf8Base64(
    JSON.stringify({
      executable: argv[0],
      runner: `@echo off\r\n@chcp 65001 >nul\r\n${command}\r\nexit /b %errorlevel%\r\n`
    })
  )
}

function buildCustomAgentWindowsLaunch(
  argv: readonly [string, ...string[]],
  shell: 'cmd' | 'powershell'
): CustomAgentLaunch {
  const script = [
    `$runnerPayload = $env:${WINDOWS_RUNNER_ENV};`,
    `Remove-Item Env:${WINDOWS_RUNNER_ENV} -ErrorAction SilentlyContinue;`,
    '$launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($runnerPayload)) | ConvertFrom-Json;',
    '$escapedCommand = [Management.Automation.WildcardPattern]::Escape([string]$launch.executable);',
    `$env:${WINDOWS_EXECUTABLE_ENV} = (Get-Command -Name $escapedCommand -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source;`,
    "$runnerPath = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'orca-agent-' + [Guid]::NewGuid().ToString('N') + '.cmd')",
    '; $runnerExit = 1; try {',
    '[IO.File]::WriteAllText($runnerPath, [string]$launch.runner, [Text.UTF8Encoding]::new($false));',
    '& cmd.exe /d /q /v:off /c $runnerPath; $runnerExit = $LASTEXITCODE',
    `} finally { Remove-Item Env:${WINDOWS_EXECUTABLE_ENV} -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $runnerPath -Force -ErrorAction SilentlyContinue };`
  ].join(' ')
  const command =
    shell === 'cmd'
      ? `powershell.exe -NoProfile -NonInteractive -Command "${script} exit $runnerExit" & set "${WINDOWS_RUNNER_ENV}="`
      : `${script} & cmd.exe /d /c exit $runnerExit`
  return {
    command,
    env: { [WINDOWS_RUNNER_ENV]: buildWindowsRunnerPayload(argv) }
  }
}
