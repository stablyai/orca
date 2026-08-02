import { isWslShellName } from '../../../../shared/local-windows-terminal-runtime'

export function getFeatureSetupNpxPreflightContext(
  platform: NodeJS.Platform,
  terminalWindowsShell: string | undefined,
  terminalWindowsWslDistro: string | null | undefined
): { wslDistro?: string; wslDefault?: boolean } | undefined {
  if (platform !== 'win32' || !isWslShellName(terminalWindowsShell)) {
    return undefined
  }
  const distro = terminalWindowsWslDistro?.trim()
  return distro ? { wslDistro: distro } : { wslDefault: true }
}
