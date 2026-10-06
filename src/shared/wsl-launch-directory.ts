/**
 * Where the Windows host writes a WSL session's staged launch lines and launch files: a directory
 * in the distro's home, written through `\\wsl.localhost`, and named inside the distro by its Linux
 * path. Resolved once in main, so the daemon never has to ask `wsl.exe`.
 */
export type WslLaunchDirectory = {
  distro: string
  /** The UNC form the Windows host writes through. */
  windowsPath: string
  /** The same directory as the distro's shell and agent read it. */
  linuxPath: string
  /** The login shell the pane runs; the host sees only wsl.exe, and this decides how to source. */
  shell?: string
}

export function parseWslLaunchDirectory(value: unknown): WslLaunchDirectory | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('distro' in value) ||
    !('windowsPath' in value) ||
    !('linuxPath' in value)
  ) {
    return undefined
  }
  const { distro, windowsPath, linuxPath } = value
  const shell = 'shell' in value && typeof value.shell === 'string' ? value.shell : undefined
  return typeof distro === 'string' &&
    typeof windowsPath === 'string' &&
    windowsPath.startsWith('\\\\') &&
    typeof linuxPath === 'string' &&
    linuxPath.startsWith('/')
    ? { distro, windowsPath, linuxPath, ...(shell?.startsWith('/') ? { shell } : {}) }
    : undefined
}
