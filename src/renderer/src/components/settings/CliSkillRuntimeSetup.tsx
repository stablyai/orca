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
import { getProjectAgentSkillTerminalShellOverride } from '@/lib/project-skill-runtime'
import { useAppStore } from '@/store'
import { buildAgentFeatureSkillInstallCommand } from '../../../../shared/agent-feature-install-commands'
import { toast } from 'sonner'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import {
  isOrcaCliAvailableOnPath,
  showOrcaCliRegistrationPromptToast
} from '@/lib/agent-skill-cli-prerequisite'
import { translate } from '@/i18n/i18n'

export type LocalAgentRuntime = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
  hostPlatform?: NodeJS.Platform
  terminalWindowsShell?: string | null
  runtimeEnvironmentId?: string | null
  runtimeOwnershipResolved?: boolean
  label: string
}

const LOCAL_HOST_AGENT_RUNTIME: LocalAgentRuntime = {
  runtime: 'host',
  label: ''
}

export function getHostRuntimeLabel(hostPlatform?: NodeJS.Platform): string {
  return hostPlatform === 'win32' ? 'Windows' : 'This device'
}

export function getSelectedAgentRuntime(
  settings: GlobalSettings,
  wslSupportedPlatform: boolean,
  wslAvailable: boolean,
  wslCapabilitiesLoading: boolean,
  hostPlatform: NodeJS.Platform | null = getSkillCommandPlatform()
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
      hostPlatform: 'win32',
      label: selectedDistro
        ? `WSL ${selectedDistro}`
        : translate('auto.components.settings.CliSkillRuntimeSetup.c47127f222', 'WSL default')
    }
  }
  return {
    runtime: 'host',
    hostPlatform: hostPlatform ?? undefined,
    label: getHostRuntimeLabel(hostPlatform ?? undefined)
  }
}

function encodeWslLoginShellScript(command: string): string {
  const bytes = new TextEncoder().encode(buildWslLoginShellCommand(command))
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export function getWslCliDistroRequest(
  runtime?: LocalAgentRuntime
): { distro: string } | undefined {
  return runtime?.runtime === 'wsl' && runtime.wslDistro?.trim()
    ? { distro: runtime.wslDistro.trim() }
    : undefined
}

export function buildSkillCommandForRuntime(
  command: string,
  runtime?: LocalAgentRuntime,
  currentPlatform = getRuntimeHostPlatform(runtime)
): string {
  const resolvedRuntime = runtime ?? LOCAL_HOST_AGENT_RUNTIME
  const normalizedCommand = normalizeWindowsSkillUpdateCommand(
    command,
    resolvedRuntime,
    currentPlatform
  )
  if (resolvedRuntime.runtime !== 'wsl') {
    return wrapWindowsSkillCommandWithNpxPrerequisite(
      normalizedCommand,
      currentPlatform,
      'copied-command',
      resolvedRuntime
    )
  }
  return normalizedCommand
}

function normalizeWindowsSkillUpdateCommand(
  command: string,
  runtime: LocalAgentRuntime,
  currentPlatform: NodeJS.Platform | undefined
): string {
  if (runtime.runtime === 'wsl' || currentPlatform !== 'win32') {
    return command
  }

  const trimmedCommand = command.trim()
  const updateMatch = /^npx\s+skills\s+update\s+([A-Za-z0-9_-]+)\s+--global$/i.exec(trimmedCommand)
  if (!updateMatch) {
    return command
  }

  // Why: the `skills update` subcommand is currently unreliable on native
  // Windows, while reinstalling from the same repo source is idempotent and
  // keeps the setup affordance working.
  return buildAgentFeatureSkillInstallCommand([updateMatch[1]])
}

/**
 * Where a built skill command is going: the user's clipboard (their own shell)
 * or the setup terminal Orca spawns itself.
 */
type SkillCommandTarget = 'copied-command' | 'orca-setup-terminal'

/**
 * Adapts a copied skill command for Orca's inline setup terminal auto-paste.
 * Host Windows installs may gain an npx preflight; WSL-targeted PowerShell wrappers
 * must become bash-native because the daemon forces wsl.exe for WSL worktrees.
 */
export function buildSkillSetupTerminalCommand(
  copiedCommand: string,
  effectiveShell: string | undefined,
  runtime?: LocalAgentRuntime,
  currentPlatform = getRuntimeHostPlatform(runtime)
): string {
  // Why: the created tab is authoritative when project runtime replaces the requested shell.
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
    'orca-setup-terminal',
    runtime ?? LOCAL_HOST_AGENT_RUNTIME
  )
}

function buildPowerShellWslSkillCommand(command: string, runtime: LocalAgentRuntime): string {
  const distroArg = runtime.wslDistro?.trim()
    ? ` -d ${quotePowerShellLiteral(runtime.wslDistro.trim())}`
    : ''
  // Why: encoding preserves the user's configured login-shell PATH across the Windows argv boundary.
  const encodedScript = encodeWslLoginShellScript(command)
  const visibleCommand = command.replace(/[\r\n]+/g, ' ')
  // Why $(...) and not a backtick eval: PowerShell treats ` as its own escape
  // character, so the old `eval "\`printf ...\`"` had the payload's quotes
  // interacting with two escaping layers and dash saw `case  in` -- the
  // `word unexpected (expecting "in")` in #14292. Credit: #14785.
  //
  // Why not a plain pipe into sh: that hands the payload the pipe as its stdin,
  // so a setup command that reads input gets base64 remnants instead. Command
  // substitution runs in a subshell and leaves the terminal's stdin intact.
  const shellScript = `sh -c "$(printf %s ${encodedScript} | base64 -d)"`
  // Why --exec: `--` makes wsl.exe expand $name in the argv it forwards to the guest.
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

  // Why both separators: commands persisted before the --exec switch must still decode.
  const encoded =
    // Both shapes: commands persisted before the pipe switch still decode.
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

function getRuntimeHostPlatform(runtime?: LocalAgentRuntime): NodeJS.Platform | undefined {
  if (!runtime) {
    return getSkillCommandPlatform()
  }
  return runtime.hostPlatform ?? (runtime.runtime === 'wsl' ? 'win32' : undefined)
}

function wrapWindowsSkillCommandWithNpxPrerequisite(
  command: string,
  currentPlatform: NodeJS.Platform | undefined,
  target: SkillCommandTarget,
  runtime: LocalAgentRuntime
): string {
  const trimmedCommand = command.trim()
  if (
    currentPlatform !== 'win32' ||
    // Why: the copied command lands in the user's configured shell, and MSYS
    // shells rewrite cmd.exe's leading /d /s /c switches into drive paths,
    // starting an interactive cmd session instead of running the payload.
    (target === 'copied-command' && isPosixFamilyWindowsShellConfigured(runtime)) ||
    !/^npx\s+skills\s+(?:add|update)\b/i.test(trimmedCommand)
  ) {
    return command
  }

  const missingNpxGuidance =
    'echo ERROR: npx was not found. Install Node.js LTS from https://nodejs.org/ to get npx. & echo Then close this terminal and start skill setup again - a new terminal picks up the updated PATH. & exit /b 1'
  // Why: cmd.exe is one shell-neutral boundary for PowerShell and Command
  // Prompt, and it resolves the bare name through PATHEXT for both the
  // preflight and the executed command, so shims such as npx.exe still count.
  return `cmd.exe /d /s /c "where.exe npx >nul 2>nul & if errorlevel 1 (${missingNpxGuidance}) else (${trimmedCommand})"`
}

function isPosixFamilyWindowsShellConfigured(runtime: LocalAgentRuntime): boolean {
  if ('terminalWindowsShell' in runtime) {
    return runtime.terminalWindowsShell === undefined
      ? true
      : ['posix', 'unix'].includes(resolveWindowsShellStartupFamily(runtime.terminalWindowsShell))
  }
  return ['posix', 'unix'].includes(
    resolveWindowsShellStartupFamily(useAppStore.getState().settings?.terminalWindowsShell)
  )
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

export function buildSkillInstallCommandForRuntime(
  command: string,
  runtime: LocalAgentRuntime
): string {
  return buildSkillCommandForRuntime(command, runtime)
}

export function getSkillDiscoveryTargetForRuntime(
  runtime: LocalAgentRuntime
): { runtime: 'wsl'; wslDistro?: string | null } | undefined {
  return runtime.runtime === 'wsl'
    ? { runtime: 'wsl', wslDistro: runtime.wslDistro ?? null }
    : undefined
}

export function getAgentSkillTerminalShellOverride(
  currentPlatform: NodeJS.Platform | undefined,
  settings: GlobalSettings,
  runtime: LocalAgentRuntime
): string | undefined {
  if (!currentPlatform) {
    return undefined
  }
  return getProjectAgentSkillTerminalShellOverride(currentPlatform, settings, runtime)
}

export async function ensureWslCliAvailableForAgentSkillTerminal(
  runtime?: LocalAgentRuntime
): Promise<CliInstallStatus | null> {
  const args = getWslCliDistroRequest(runtime)
  try {
    const status = await window.api.cli.getWslInstallStatus(args)
    if (!status.supported) {
      toast.warning(
        translate(
          'auto.components.settings.CliSkillRuntimeSetup.775a4cfbb8',
          'WSL shell command registration is unavailable'
        ),
        {
          description:
            status.detail ??
            translate(
              'auto.components.settings.CliSkillRuntimeSetup.fc0fcf72fd',
              'Register the WSL shell command before skill setup.'
            )
        }
      )
      return status
    }
    if (status.pathConfigured === null) {
      toast.warning(
        translate(
          'auto.components.settings.CliSkillRuntimeSetup.windowsPathUnknown',
          'WSL shell command PATH could not be checked'
        ),
        {
          description:
            status.detail ??
            translate(
              'auto.components.settings.CliSkillRuntimeSetup.refreshCliRegistration',
              'Refresh CLI registration status and try again.'
            )
        }
      )
      return status
    }
    if (status.state !== 'installed' || status.pathConfigured === false) {
      await showOrcaCliRegistrationPromptToast()
      const next = await window.api.cli.installWsl(args)
      if (!isOrcaCliAvailableOnPath(next)) {
        toast.warning(
          translate(
            'auto.components.settings.CliSkillRuntimeSetup.3728a94fb6',
            'WSL shell command needs attention'
          ),
          {
            description:
              next.detail ??
              translate(
                'auto.components.settings.CliSkillRuntimeSetup.fc0fcf72fd',
                'Register the WSL shell command before skill setup.'
              )
          }
        )
      }
      return next
    }
    return status
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.components.settings.CliSkillRuntimeSetup.0ed08febc5',
            'Failed to register the WSL shell command.'
          )
    )
    return null
  }
}
