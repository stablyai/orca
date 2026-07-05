import { resolveWindowsShellLaunchArgs } from './windows-terminal-launch-plan'
import {
  getWindowsShellBasename,
  isWindowsPowerShellShellPath,
  shouldLaunchWindowsPowerShellWithoutProfile
} from './windows-terminal-shell-resolution'

export function getWindowsRelayShellArgs(
  shellName: string,
  env: Record<string, string>,
  options: { terminalWindowsWslDistro?: string | null } = {}
): string[] | null {
  const launchOptions = {
    powerShellNoProfile: shouldLaunchWindowsPowerShellWithoutProfile(env)
  }
  if (isWindowsPowerShellShellPath(shellName)) {
    return resolveWindowsShellLaunchArgs(shellName, '', '', undefined, undefined, launchOptions)
      .shellArgs
  }
  const basename = getWindowsShellBasename(shellName)
  if (basename === 'cmd.exe' || basename === 'cmd') {
    return []
  }
  if (basename === 'wsl.exe' || basename === 'wsl') {
    const distro = options.terminalWindowsWslDistro?.trim()
    return distro ? ['-d', distro] : []
  }
  return null
}

export function getWindowsRelayShellLaunchPlan(
  shellName: string,
  env: Record<string, string>,
  options: { emitReadyMarker?: boolean; terminalWindowsWslDistro?: string | null } = {}
): { args: string[]; env: Record<string, string> } | null {
  const args = getWindowsRelayShellArgs(shellName, env, {
    terminalWindowsWslDistro: options.terminalWindowsWslDistro
  })
  if (args === null) {
    return null
  }
  return {
    args,
    env:
      options.emitReadyMarker === true && isWindowsPowerShellShellPath(shellName)
        ? { ORCA_SHELL_READY_MARKER: '1' }
        : {}
  }
}
