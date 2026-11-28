import type { ProjectExecutionRuntimeResolution } from '../../execution-host/project-execution-runtime'
import type { GlobalSettings } from '../../settings/global-settings-types'

type LocalWindowsTerminalRuntimeSettings =
  | Partial<
      Pick<
        GlobalSettings,
        'terminalWindowsShell' | 'terminalWindowsWslDistro' | 'terminalWindowsUseCustomShell'
      >
    >
  | undefined

export type LocalWindowsTerminalRuntimeOptions = {
  shellOverride: string | undefined
  terminalWindowsWslDistro: string | null
}

export function isWslShellName(shellPath: string | undefined): boolean {
  const shellName = shellPath?.replaceAll('\\', '/').split('/').pop()?.toLowerCase()
  return shellName === 'wsl.exe' || shellName === 'wsl'
}

export function resolveConfiguredWindowsShell(
  settings: LocalWindowsTerminalRuntimeSettings
): string | undefined {
  const savedShell = settings?.terminalWindowsShell
  // Legacy WSL defaults predate project runtime selection.
  return settings?.terminalWindowsUseCustomShell && isWslShellName(savedShell)
    ? 'powershell.exe'
    : savedShell
}

export function getHostShellForProjectRuntime(
  requestedShell: string | undefined,
  settingsShell: string | undefined,
  fallbackHostShell = 'powershell.exe'
): string {
  const candidate = requestedShell ?? settingsShell
  if (candidate && !isWslShellName(candidate)) {
    return candidate
  }
  return fallbackHostShell
}

export function resolveLocalWindowsTerminalRuntimeOptions(args: {
  requestedShellOverride: string | undefined
  settings: LocalWindowsTerminalRuntimeSettings
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
  fallbackHostShell?: string
  /** OpenSSH login shell; outranks only the shipped `powershell.exe` default, as on the relay. */
  sshLoginShell?: string
}): LocalWindowsTerminalRuntimeOptions {
  const configuredShell = resolveConfiguredWindowsShell(args.settings)
  const settingsShell =
    args.sshLoginShell && (!configuredShell || configuredShell === 'powershell.exe')
      ? args.sshLoginShell
      : configuredShell
  const settingsWslDistro = args.settings?.terminalWindowsWslDistro ?? null
  const projectRuntime = args.projectRuntime
  if (!projectRuntime) {
    return {
      shellOverride: args.requestedShellOverride ?? settingsShell,
      terminalWindowsWslDistro: settingsWslDistro
    }
  }

  if (projectRuntime.status === 'repair-required') {
    throw new Error(
      `Project runtime requires repair before terminal spawn: ${projectRuntime.repair.reason}`
    )
  }

  if (projectRuntime.runtime.kind === 'wsl') {
    return {
      shellOverride: 'wsl.exe',
      terminalWindowsWslDistro: projectRuntime.runtime.distro
    }
  }

  return {
    shellOverride: getHostShellForProjectRuntime(
      args.requestedShellOverride,
      settingsShell,
      args.fallbackHostShell
    ),
    terminalWindowsWslDistro: null
  }
}

export function resolveLocalWindowsTerminalShellOverrideForTab(args: {
  explicitShellOverride: string | undefined
  defaultWindowsShell: string | undefined
  isWslWorktree: boolean
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
  fallbackHostShell?: string
}): string | undefined {
  if (args.projectRuntime?.status === 'repair-required') {
    // Repair-required WSL still owns the runtime; advertise it rather than host metadata.
    return 'wsl.exe'
  }

  if (args.projectRuntime) {
    return resolveLocalWindowsTerminalRuntimeOptions({
      requestedShellOverride: args.explicitShellOverride,
      settings: {
        terminalWindowsShell: args.defaultWindowsShell,
        terminalWindowsWslDistro: null
      },
      projectRuntime: args.projectRuntime,
      fallbackHostShell: args.fallbackHostShell
    }).shellOverride
  }

  if (args.explicitShellOverride !== undefined) {
    return args.explicitShellOverride
  }
  if (args.isWslWorktree) {
    return 'wsl.exe'
  }
  return args.defaultWindowsShell
}
