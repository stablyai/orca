// COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  deriveGlobalWindowsRuntimeDefaultFromLegacySettings,
  normalizeGlobalWindowsRuntimeDefault
} from '../../../../shared/project-execution-runtime'
import {
  quotePowerShellLiteral,
  quotePowerShellNativeArgument
} from '../../../../shared/powershell-native-argument'
import { buildWslLoginShellCommand } from '../../../../shared/wsl-login-shell-command'
import { isWslShellName } from '../../../../shared/local-windows-terminal-runtime'
import { resolveWindowsShellStartupFamily } from '../../../../shared/windows-terminal-shell'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

export type LocalAgentRuntime = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
  label: string
}

const LOCAL_HOST_AGENT_RUNTIME: LocalAgentRuntime = {
  runtime: 'host',
  label: ''
}

export function getHostRuntimeLabel(): string {
  return navigator.userAgent.includes('Windows') ? 'Windows' : 'This device'
}

export function getSelectedAgentRuntime(
  settings: GlobalSettings,
  wslSupportedPlatform: boolean,
  wslAvailable: boolean,
  wslCapabilitiesLoading: boolean
): LocalAgentRuntime {
  const defaultRuntime = normalizeGlobalWindowsRuntimeDefault(
    settings.localWindowsRuntimeDefault ??
      deriveGlobalWindowsRuntimeDefaultFromLegacySettings(settings, {
        wslAvailable: wslCapabilitiesLoading ? undefined : wslAvailable
      }).defaultRuntime
  )
  if (wslSupportedPlatform && defaultRuntime.kind === 'wsl') {
    const selectedDistro = defaultRuntime.distro?.trim() || null
    return {
      runtime: 'wsl',
      wslDistro: selectedDistro,
      label: selectedDistro
        ? `WSL ${selectedDistro}`
        : translate('auto.components.settings.CliSkillRuntimeSetup.c47127f222', 'WSL default')
    }
  }
  return { runtime: 'host', label: getHostRuntimeLabel() }
}

function encodeWslLoginShellScript(command: string): string {
  const bytes = new TextEncoder().encode(buildWslLoginShellCommand(command))
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export function buildSkillCommandForRuntime(
  command: string,
  runtime?: LocalAgentRuntime,
  currentPlatform = getSkillCommandPlatform()
): string {
  const resolvedRuntime = runtime ?? LOCAL_HOST_AGENT_RUNTIME
  if (resolvedRuntime.runtime !== 'wsl') {
    return wrapWindowsSkillCommandWithNpxPrerequisite(command, currentPlatform, 'copied-command')
  }
  return command
}

type SkillCommandTarget = 'copied-command' | 'orca-setup-terminal'

/** Adapt clipboard commands for setup terminals: Windows may need npx preflight; WSL wrappers must become native bash for daemon-forced wsl.exe. */
export function buildSkillSetupTerminalCommand(
  copiedCommand: string,
  effectiveShell: string | undefined,
  runtime?: LocalAgentRuntime,
  currentPlatform = getSkillCommandPlatform()
): string {
  // The created tab’s shell wins when project runtime overrides the requested shell.
  const wslNative = isWslShellName(effectiveShell)
    ? decodeWslSetupTerminalCommand(copiedCommand)
    : null
  if (wslNative) {
    return wslNative
  }
  if (!isSetupTerminalForcedToPowerShell(effectiveShell)) {
    return copiedCommand
  }
  if (runtime?.runtime === 'wsl' && currentPlatform === 'win32') {
    return buildPowerShellWslSkillCommand(copiedCommand, runtime)
  }
  return wrapWindowsSkillCommandWithNpxPrerequisite(
    copiedCommand,
    currentPlatform,
    'orca-setup-terminal'
  )
}

function buildPowerShellWslSkillCommand(command: string, runtime: LocalAgentRuntime): string {
  const distroArg = runtime.wslDistro?.trim()
    ? ` -d ${quotePowerShellLiteral(runtime.wslDistro.trim())}`
    : ''
  // Encode across Windows argv without losing the configured login-shell PATH.
  const encodedScript = encodeWslLoginShellScript(command)
  const visibleCommand = command.replace(/[\r\n]+/g, ' ')
  // Command substitution avoids PowerShell backtick-escaping collisions (#14292/#14785) and preserves stdin that piping into sh would consume.
  const shellScript = `sh -c "$(printf %s ${encodedScript} | base64 -d)"`
  // Use --exec because -- expands guest-bound variable references in wsl.exe.
  const wslCommand = `wsl.exe${distroArg} --exec sh -c ${quotePowerShellNativeArgument(shellScript)}`
  return `& { $PSNativeCommandArgumentPassing = 'Legacy'; ${wslCommand} } # Runs: ${visibleCommand}`
}

function decodeWslSetupTerminalCommand(command: string): string | null {
  if (
    !command.startsWith("& { $PSNativeCommandArgumentPassing = 'Legacy'; wsl.exe") ||
    !command.includes(' } # Runs: ')
  ) {
    return null
  }

  // Decode persisted wrappers from before both the --exec and pipe changes.
  const encoded =
    /(?:--|--exec) sh -c '(?:eval \\"`|sh -c \\"\$\()?printf %s ([A-Za-z0-9+/=]+) \| base64 -d/.exec(
      command
    )?.[1]
  if (!encoded) {
    return null
  }

  try {
    const binary = atob(encoded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

function isSetupTerminalForcedToPowerShell(terminalShellOverride: string | undefined): boolean {
  const trimmedOverride = terminalShellOverride?.trim()
  return (
    Boolean(trimmedOverride) && resolveWindowsShellStartupFamily(trimmedOverride) === 'powershell'
  )
}

function wrapWindowsSkillCommandWithNpxPrerequisite(
  command: string,
  currentPlatform: NodeJS.Platform,
  target: SkillCommandTarget
): string {
  const trimmedCommand = command.trim()
  if (
    currentPlatform !== 'win32' ||
    // Never send Windows-client cmd.exe setup commands to a focused remote runtime.
    isRemoteRuntimeEnvironmentFocused() ||
    // MSYS rewrites cmd.exe switches as paths; keep copied commands out of that boundary for POSIX-family shells.
    (target === 'copied-command' && isPosixFamilyWindowsShellConfigured()) ||
    !/^npx\s+skills(?:@[\w.-]+)?\s+add\b/i.test(trimmedCommand)
  ) {
    return command
  }

  const missingNpxGuidance =
    'echo ERROR: npx was not found. Install Node.js LTS from https://nodejs.org/ to get npx. & echo Then close this terminal and start skill setup again - a new terminal picks up the updated PATH. & exit /b 1'
  // cmd.exe provides a common PowerShell/Command Prompt boundary and PATHEXT resolution for npx shims.
  return `cmd.exe /d /s /c "where.exe npx >nul 2>nul & if errorlevel 1 (${missingNpxGuidance}) else (${trimmedCommand})"`
}

function isPosixFamilyWindowsShellConfigured(): boolean {
  return ['posix', 'unix'].includes(
    resolveWindowsShellStartupFamily(useAppStore.getState().settings?.terminalWindowsShell)
  )
}

function isRemoteRuntimeEnvironmentFocused(): boolean {
  // Callers track focused ID, not environment count; conservatively skip to avoid sending cmd.exe to remote shells.
  return Boolean(useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim())
}

function getSkillCommandPlatform(): NodeJS.Platform {
  const platform =
    typeof window === 'undefined' ? undefined : window.api?.platform?.get?.()?.platform
  if (platform) {
    return platform
  }

  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (userAgent.includes('Windows')) {
    return 'win32'
  }
  if (userAgent.includes('Mac')) {
    return 'darwin'
  }
  return 'linux'
}

export function getSkillDiscoveryTargetForRuntime(
  runtime: LocalAgentRuntime
): { runtime: 'wsl'; wslDistro?: string | null } | undefined {
  return runtime.runtime === 'wsl'
    ? { runtime: 'wsl', wslDistro: runtime.wslDistro ?? null }
    : undefined
}
