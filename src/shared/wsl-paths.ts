export type WslUncPathInfo = {
  distro: string
  linuxPath: string
}

export function parseWslUncPath(path: string): WslUncPathInfo | null {
  const normalized = path.replace(/\\/g, '/')
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i)
  if (!match) {
    return null
  }

  return {
    distro: match[2],
    linuxPath: match[3] || '/'
  }
}

export function isWslUncPath(path: string): boolean {
  return parseWslUncPath(path) !== null
}

/**
 * Convert a Windows path to a Linux path for commands that will execute inside WSL.
 * Returns the path unchanged if it is already POSIX-style.
 */
export function toLinuxPath(windowsPath: string): string {
  const info = parseWslUncPath(windowsPath)
  if (info) {
    return info.linuxPath
  }

  const driveMatch = windowsPath.match(/^([A-Za-z]):[/\\](.*)$/)
  if (!driveMatch) {
    return windowsPath
  }

  const driveLetter = driveMatch[1].toLowerCase()
  const rest = driveMatch[2].replace(/\\/g, '/')
  return `/mnt/${driveLetter}/${rest}`
}

/**
 * Convert a Linux path inside a WSL distro to a Windows path.
 */
export function toWindowsWslPath(linuxPath: string, distro: string): string {
  const mntMatch = linuxPath.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i)
  if (mntMatch) {
    const driveLetter = mntMatch[1].toUpperCase()
    const rest = mntMatch[2] ? mntMatch[2].replace(/\//g, '\\') : ''
    return `${driveLetter}:\\${rest}`
  }

  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}
