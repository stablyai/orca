export function getRevealLabel(platform: string): string {
  if (platform === 'darwin') {
    return 'Show in Finder'
  }
  if (platform === 'win32') {
    return 'Show in Explorer'
  }
  return 'Show in File Manager'
}

export function getInstallDescription(platform: string): string {
  if (platform === 'darwin') {
    return 'Register `orca` in /usr/local/bin.'
  }
  if (platform === 'linux') {
    return 'Register `orca-ide` in ~/.local/bin.'
  }
  if (platform === 'win32') {
    return 'Register `orca` in your user PATH.'
  }
  return 'CLI registration is not yet available on this platform.'
}

export function getFallbackCommandName(platform: string): string {
  return platform === 'linux' ? 'orca-ide' : 'orca'
}
