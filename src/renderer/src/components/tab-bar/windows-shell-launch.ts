export function resolveWindowsShellLaunchTarget(
  shell: 'powershell.exe' | 'cmd.exe' | 'wsl.exe',
  powerShellImplementation: 'auto' | 'powershell.exe' | 'pwsh.exe',
  pwshAvailable: boolean
): string {
  if (shell !== 'powershell.exe') {
    return shell
  }

  if (powerShellImplementation === 'auto') {
    return pwshAvailable ? 'pwsh.exe' : 'powershell.exe'
  }

  return powerShellImplementation
}
