export function getMCodeCliCommandNameForPlatform(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return 'mcode-ide'
  }
  if (platform === 'win32') {
    return 'mcode.cmd'
  }
  return 'mcode'
}
