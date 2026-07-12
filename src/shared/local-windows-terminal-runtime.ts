import type { ProjectExecutionRuntimeResolution } from './project-execution-runtime'
import { resolveDefaultShell, type ProjectDefaultShell } from './project-default-shell'
import type { GlobalSettings } from './types'

type LocalWindowsTerminalRuntimeSettings =
  | Partial<Pick<GlobalSettings, 'terminalWindowsShell' | 'terminalWindowsWslDistro'>>
  | undefined

export type LocalWindowsTerminalRuntimeOptions = {
  shellOverride: string | undefined
  terminalWindowsWslDistro: string | null
}

/** True when the shell's basename is `wsl.exe`/`wsl`, regardless of path or slash style. */
export function isWslShellName(shellPath: string | undefined): boolean {
  const shellName = shellPath?.replaceAll('\\', '/').split('/').pop()?.toLowerCase()
  return shellName === 'wsl.exe' || shellName === 'wsl'
}

/**
 * Pick the shell for a windows-host spawn, falling back to `fallbackHostShell`
 * when the requested/settings candidate names a WSL shell (a host spawn must not use `wsl.exe`).
 */
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

/**
 * Resolve the shell and WSL distro to spawn a local Windows terminal with, given
 * the project's runtime resolution. WSL projects always spawn `wsl.exe` into their
 * bound distro; windows-host projects fall through to resolveDefaultShell's precedence.
 */
export function resolveLocalWindowsTerminalRuntimeOptions(args: {
  requestedShellOverride: string | undefined
  settings: LocalWindowsTerminalRuntimeSettings
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
  fallbackHostShell?: string
  /** Terminal default-shell axis (T2's Project.defaultShell) — windows-host only. */
  projectDefaultShell?: ProjectDefaultShell
}): LocalWindowsTerminalRuntimeOptions {
  const settingsShell = args.settings?.terminalWindowsShell
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
    // Why: resolveDefaultShell owns the creationOverride > project > global
    // precedence (T2); the global fallback still runs through
    // getHostShellForProjectRuntime so a WSL-named global setting can't leak
    // into a windows-host spawn.
    shellOverride: resolveDefaultShell({
      creationOverride: args.requestedShellOverride,
      projectDefaultShell: args.projectDefaultShell ?? 'inherit',
      runtime: projectRuntime,
      globalDefaultShell: getHostShellForProjectRuntime(
        undefined,
        settingsShell,
        args.fallbackHostShell
      )
    }),
    terminalWindowsWslDistro: null
  }
}

/**
 * Renderer-side mirror of resolveLocalWindowsTerminalRuntimeOptions, used to label a
 * terminal tab with the shell main will actually spawn, without duplicating its full settings shape.
 */
export function resolveLocalWindowsTerminalShellOverrideForTab(args: {
  explicitShellOverride: string | undefined
  defaultWindowsShell: string | undefined
  isWslWorktree: boolean
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
  fallbackHostShell?: string
  /** Terminal default-shell axis (T2's Project.defaultShell) — windows-host only. */
  projectDefaultShell?: ProjectDefaultShell
}): string | undefined {
  if (args.projectRuntime?.status === 'repair-required') {
    // Why: repair-required WSL still owns the project runtime; the tab should
    // advertise the intended runtime instead of falling back to host metadata.
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
      fallbackHostShell: args.fallbackHostShell,
      // Why: keep the tab label in sync with main's authoritative spawn
      // decision (resolveLocalWindowsTerminalRuntimeOptions), which already
      // honors this axis — see 2287f47af.
      projectDefaultShell: args.projectDefaultShell
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
