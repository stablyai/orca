import type { GlobalSettings } from '../../../../shared/types'
import {
  deriveGlobalWindowsRuntimeDefaultFromLegacySettings,
  normalizeGlobalWindowsRuntimeDefault
} from '../../../../shared/project-execution-runtime'
import {
  quotePowerShellLiteral,
  quotePowerShellNativeArgument
} from '../../../../shared/powershell-native-argument'
import { buildWslLoginShellCommand } from '../../../../shared/wsl-login-shell-command'
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
  currentPlatform = getSkillCommandPlatform()
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
      'copied-command'
    )
  }

  const distroArg = resolvedRuntime.wslDistro?.trim()
    ? ` -d ${quotePowerShellLiteral(resolvedRuntime.wslDistro.trim())}`
    : ''
  // Why: encoding preserves the user's configured login-shell PATH while
  // avoiding raw multiline and nested quotes at the copy/paste boundary.
  const encodedScript = encodeWslLoginShellScript(normalizedCommand)
  const visibleCommand = normalizedCommand.replace(/[\r\n]+/g, ' ')
  const shellScript = `eval "\`printf %s ${encodedScript} | base64 -d\`"`
  const wslCommand = `wsl.exe${distroArg} -- sh -c ${quotePowerShellNativeArgument(shellScript)}`
  // Why: scope Legacy argv parsing to this invocation so Windows PowerShell
  // 5.1 and PowerShell 7 pass the same embedded quotes to wsl.exe.
  return `& { $PSNativeCommandArgumentPassing = 'Legacy'; ${wslCommand} } # Runs: ${visibleCommand}`
}

function normalizeWindowsSkillUpdateCommand(
  command: string,
  runtime: LocalAgentRuntime,
  currentPlatform: NodeJS.Platform
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
 * Re-adds the npx preflight for Orca's own setup terminal, which
 * `getAgentSkillTerminalShellOverride` forces onto powershell.exe. The copied
 * string stays bare for POSIX-family shells; only the executed one is wrapped.
 */
export function buildSkillSetupTerminalCommand(
  copiedCommand: string,
  terminalShellOverride: string | undefined,
  currentPlatform = getSkillCommandPlatform()
): string {
  if (!isSetupTerminalForcedToPowerShell(terminalShellOverride)) {
    return copiedCommand
  }
  return wrapWindowsSkillCommandWithNpxPrerequisite(
    copiedCommand,
    currentPlatform,
    'orca-setup-terminal'
  )
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
    // Why: skill setup terminals spawn on the focused runtime environment, so a
    // Windows client must not hand a cmd.exe command to a remote host.
    isRemoteRuntimeEnvironmentFocused() ||
    // Why: the copied command lands in the user's configured shell, and MSYS
    // shells rewrite cmd.exe's leading /d /s /c switches into drive paths,
    // starting an interactive cmd session instead of running the payload.
    (target === 'copied-command' && isPosixFamilyWindowsShellConfigured()) ||
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

function isPosixFamilyWindowsShellConfigured(): boolean {
  return (
    resolveWindowsShellStartupFamily(useAppStore.getState().settings?.terminalWindowsShell) ===
    'posix'
  )
}

function isRemoteRuntimeEnvironmentFocused(): boolean {
  // Why: the terminal router also weighs how many environments are saved, but
  // that slice has no subscriber here. Read only the focused id, which every
  // caller re-renders on: it over-skips rather than ever handing a cmd.exe
  // command to a remote shell.
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
  currentPlatform: string,
  settings: GlobalSettings,
  runtime: LocalAgentRuntime
): string | undefined {
  return getProjectAgentSkillTerminalShellOverride(
    currentPlatform as NodeJS.Platform,
    settings,
    runtime
  )
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
