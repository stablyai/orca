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

// Matches the legacy \\wsl$\ (or //wsl$/) share prefix, capturing the leading
// separator pair and the separator that follows the share name.
const WSL_LEGACY_UNC_PREFIX_RE = /^(\/\/|\\\\)wsl\$([/\\])/i

/**
 * Rewrite the legacy `\\wsl$\` share prefix to the modern `\\wsl.localhost\` form.
 *
 * Why: the WSL filesystem watcher only emits `\\wsl.localhost\` paths, so repos
 * added or persisted under the legacy prefix must canonicalize to this form to
 * dedup and compare equal against watcher-sourced paths.
 */
export function normalizeWslUncPrefix(path: string): string {
  return path.replace(WSL_LEGACY_UNC_PREFIX_RE, '$1wsl.localhost$2')
}

/**
 * Convert a Linux path inside a WSL distro to a Windows path.
 *
 * Why two forms: paths under /mnt/<drive>/... are Windows-native filesystem
 * paths that WSL exposes via the DrvFs mount. These map back to their native
 * Windows form (e.g. /mnt/c/Users → C:\Users). All other paths live on the
 * WSL virtual filesystem and use the UNC form (\\wsl.localhost\Distro\...).
 *
 * Why here (shared, not main-only): both the main-process Git/hooks layer and
 * the renderer's terminal-link resolver (WSL POSIX terminal links, #8156) need
 * this pure conversion, and it has no Node dependency.
 */
export function toWindowsWslPath(linuxPath: string, distro: string): string {
  // /mnt/c/Users/... → C:\Users\...
  const mntMatch = linuxPath.match(/^\/mnt\/([a-z])(\/.*)?$/)
  if (mntMatch) {
    const driveLetter = mntMatch[1].toUpperCase()
    const rest = (mntMatch[2] || '').replace(/\//g, '\\')
    return `${driveLetter}:${rest || '\\'}`
  }

  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}
